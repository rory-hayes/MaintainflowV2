package health

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"time"
)

type Server struct {
	ready func() bool
}

func New(ready func() bool) (*Server, error) {
	if ready == nil {
		return nil, errors.New("readiness callback is required")
	}
	return &Server{ready: ready}, nil
}

func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	if listener == nil || !isLoopback(listener.Addr()) {
		return errors.New("health listener must be loopback-only")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/livez", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/readyz", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !s.ready() {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		writer.WriteHeader(http.StatusOK)
	})
	httpServer := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: time.Second,
		ReadTimeout:       time.Second,
		WriteTimeout:      time.Second,
		IdleTimeout:       time.Second,
		MaxHeaderBytes:    4 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = httpServer.Shutdown(shutdownContext)
		case <-done:
		}
	}()
	err := httpServer.Serve(listener)
	close(done)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func isLoopback(address net.Addr) bool {
	tcpAddress, ok := address.(*net.TCPAddr)
	return ok && tcpAddress.IP != nil && tcpAddress.IP.IsLoopback()
}
