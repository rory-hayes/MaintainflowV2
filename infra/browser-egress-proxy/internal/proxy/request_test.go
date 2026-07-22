package proxy

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func TestParseConnectRequestCanonicalOnly(t *testing.T) {
	t.Parallel()
	request, err := ParseConnectRequest([]byte("CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nUser-Agent: internal\r\n\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if request.Hostname != "public.example.net" {
		t.Fatalf("hostname = %q", request.Hostname)
	}
}

func TestParseConnectRequestRejectsAmbiguousForms(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		raw    string
		reason RequestReason
	}{
		{"method", "GET public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\n\r\n", RequestUnsupported},
		{"version", "CONNECT public.example.net:443 HTTP/2.0\r\nHost: public.example.net:443\r\n\r\n", RequestUnsupported},
		{"h2 preface", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", RequestUnsupported},
		{"absolute URL", "CONNECT https://public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\n\r\n", RequestInvalidAuthority},
		{"noncanonical case", "CONNECT PUBLIC.example.net:443 HTTP/1.1\r\nHost: PUBLIC.example.net:443\r\n\r\n", RequestInvalidAuthority},
		{"trailing root", "CONNECT public.example.net.:443 HTTP/1.1\r\nHost: public.example.net.:443\r\n\r\n", RequestInvalidAuthority},
		{"host mismatch", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: other.example.net:443\r\n\r\n", RequestInvalidAuthority},
		{"duplicate host", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nHost: public.example.net:443\r\n\r\n", RequestUnsupported},
		{"content length zero", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nContent-Length: 0\r\n\r\n", RequestBodyNotAllowed},
		{"chunked", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nTransfer-Encoding: chunked\r\n\r\n", RequestBodyNotAllowed},
		{"upgrade", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nConnection: upgrade\r\nUpgrade: h2c\r\n\r\n", RequestUnsupported},
		{"proxy auth", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nProxy-Authorization: secret\r\n\r\n", RequestUnsupported},
		{"obs fold", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\n folded\r\n\r\n", RequestUnsupported},
		{"bare linefeed", "CONNECT public.example.net:443 HTTP/1.1\nHost: public.example.net:443\r\n\r\n", RequestUnsupported},
		{"pipeline", "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\n\r\nextra", RequestUnsupported},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseConnectRequest([]byte(test.raw))
			assertRequestReason(t, err, test.reason)
		})
	}
}

func TestReadConnectRequestBoundsAndRejectsPreResponseBytes(t *testing.T) {
	t.Parallel()
	request := "CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\nX-Fill: " + strings.Repeat("a", 128) + "\r\n\r\n"
	firstClient, firstServer := net.Pipe()
	done := make(chan error, 1)
	go func(client net.Conn) {
		_, err := client.Write([]byte(request + "target-preface"))
		done <- err
		_ = client.Close()
	}(firstClient)
	_, err := ReadConnectRequest(firstServer, DefaultMaxConnectHeaderBytes, time.Second)
	assertRequestReason(t, err, RequestBodyNotAllowed)
	_ = firstServer.Close()
	<-done

	secondClient, secondServer := net.Pipe()
	go func(client net.Conn) {
		_, _ = client.Write([]byte(strings.Repeat("a", 65)))
		_ = client.Close()
	}(secondClient)
	_, err = ReadConnectRequest(secondServer, 64, time.Second)
	assertRequestReason(t, err, RequestHeaderLimit)
	_ = secondServer.Close()
}

func TestReadConnectRequestTimeout(t *testing.T) {
	t.Parallel()
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	_, err := ReadConnectRequest(server, DefaultMaxConnectHeaderBytes, 20*time.Millisecond)
	assertRequestReason(t, err, RequestHeaderTimeout)
}

func FuzzParseConnectRequest(f *testing.F) {
	f.Add([]byte("CONNECT public.example.net:443 HTTP/1.1\r\nHost: public.example.net:443\r\n\r\n"))
	f.Add([]byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"))
	f.Fuzz(func(t *testing.T, raw []byte) {
		request, err := ParseConnectRequest(raw)
		if err == nil {
			if request.Hostname == "" || len(raw) > DefaultMaxConnectHeaderBytes {
				t.Fatalf("accepted invalid bounded request")
			}
		}
	})
}

func assertRequestReason(t *testing.T, err error, reason RequestReason) {
	t.Helper()
	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Reason != reason {
		t.Fatalf("error = %v, want reason %s", err, reason)
	}
}
