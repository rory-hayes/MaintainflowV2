package health

import (
	"context"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestHealthIsLocalAndUsesOnlyInMemoryReadiness(t *testing.T) {
	t.Parallel()
	var ready atomic.Bool
	server, err := New(ready.Load)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + listener.Addr().String() + "/livez")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("liveness = %v, %v", response, err)
	}
	_ = response.Body.Close()
	response, err = client.Get("http://" + listener.Addr().String() + "/readyz")
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unready = %v, %v", response, err)
	}
	_ = response.Body.Close()
	ready.Store(true)
	response, err = client.Get("http://" + listener.Addr().String() + "/readyz")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("ready = %v, %v", response, err)
	}
	_ = response.Body.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHealthRejectsNonLoopbackListener(t *testing.T) {
	t.Parallel()
	server, _ := New(func() bool { return true })
	listener := &fakeListener{address: &net.TCPAddr{IP: net.ParseIP("10.0.0.1"), Port: 8081}}
	if err := server.Serve(context.Background(), listener); err == nil {
		t.Fatal("non-loopback listener accepted")
	}
}

type fakeListener struct{ address net.Addr }

func (f *fakeListener) Accept() (net.Conn, error) { return nil, net.ErrClosed }
func (f *fakeListener) Close() error              { return nil }
func (f *fakeListener) Addr() net.Addr            { return f.address }
