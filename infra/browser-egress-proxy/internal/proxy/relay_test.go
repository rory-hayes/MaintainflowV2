package proxy

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func tcpPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan *net.TCPConn, 1)
	errors := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			errors <- acceptErr
			return
		}
		accepted <- connection.(*net.TCPConn)
	}()
	peer, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case server := <-accepted:
		return peer.(*net.TCPConn), server
	case err := <-errors:
		peer.Close()
		t.Fatal(err)
		return nil, nil
	}
}

func TestRelayPreservesHalfCloseAndCountsBytes(t *testing.T) {
	t.Parallel()
	clientPeer, relayClient := tcpPair(t)
	relayUpstream, targetPeer := tcpPair(t)
	defer clientPeer.Close()
	defer relayClient.Close()
	defer relayUpstream.Close()
	defer targetPeer.Close()

	result := make(chan RelayResult, 1)
	go func() { result <- Relay(context.Background(), relayClient, relayUpstream, DefaultRelayConfig()) }()
	if _, err := clientPeer.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := clientPeer.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	request, err := io.ReadAll(targetPeer)
	if err != nil || string(request) != "request" {
		t.Fatalf("target request = %q, error = %v", request, err)
	}
	if _, err := targetPeer.Write([]byte("response")); err != nil {
		t.Fatal(err)
	}
	if err := targetPeer.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(clientPeer)
	if err != nil || string(response) != "response" {
		t.Fatalf("client response = %q, error = %v", response, err)
	}
	select {
	case actual := <-result:
		if actual.Reason != RelayAllowed || actual.RequestBytes != 7 || actual.ResponseBytes != 8 {
			t.Fatalf("relay result = %+v", actual)
		}
	case <-time.After(time.Second):
		t.Fatal("relay did not finish")
	}
}

func TestRelayEnforcesByteLimit(t *testing.T) {
	t.Parallel()
	clientPeer, relayClient := tcpPair(t)
	relayUpstream, targetPeer := tcpPair(t)
	defer clientPeer.Close()
	defer relayClient.Close()
	defer relayUpstream.Close()
	defer targetPeer.Close()
	config := DefaultRelayConfig()
	config.MaxRequestBytes = 4
	result := make(chan RelayResult, 1)
	go func() { result <- Relay(context.Background(), relayClient, relayUpstream, config) }()
	_, _ = clientPeer.Write([]byte("12345"))
	select {
	case actual := <-result:
		if actual.Reason != RelayUploadLimit || actual.RequestBytes > 4 {
			t.Fatalf("relay result = %+v", actual)
		}
	case <-time.After(time.Second):
		t.Fatal("relay limit did not close the tunnel")
	}
}

func TestRelayIdleTimeoutAndCancellation(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		cancel bool
		want   RelayReason
	}{
		{name: "idle", want: RelayIdleTimeout},
		{name: "cancelled", cancel: true, want: RelayCancelled},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			clientPeer, relayClient := tcpPair(t)
			relayUpstream, targetPeer := tcpPair(t)
			defer clientPeer.Close()
			defer relayClient.Close()
			defer relayUpstream.Close()
			defer targetPeer.Close()
			config := DefaultRelayConfig()
			config.IdleTimeout = 30 * time.Millisecond
			ctx, cancel := context.WithCancel(context.Background())
			if test.cancel {
				cancel()
			} else {
				defer cancel()
			}
			actual := Relay(ctx, relayClient, relayUpstream, config)
			if actual.Reason != test.want {
				t.Fatalf("relay result = %+v, want %s", actual, test.want)
			}
		})
	}
}
