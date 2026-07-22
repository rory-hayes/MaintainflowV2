package proxy

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

const (
	DefaultIdleTimeout      = 30 * time.Second
	DefaultMaxRequestBytes  = int64(2 << 20)
	DefaultMaxResponseBytes = int64(20 << 20)
)

type RelayReason string

const (
	RelayAllowed       RelayReason = "allowed"
	RelayUploadLimit   RelayReason = "upload_limit"
	RelayResponseLimit RelayReason = "response_limit"
	RelayIdleTimeout   RelayReason = "idle_timeout"
	RelayCancelled     RelayReason = "cancelled"
	RelayFailure       RelayReason = "relay_failure"
)

type RelayConfig struct {
	IdleTimeout      time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int64
}

func DefaultRelayConfig() RelayConfig {
	return RelayConfig{
		IdleTimeout:      DefaultIdleTimeout,
		MaxRequestBytes:  DefaultMaxRequestBytes,
		MaxResponseBytes: DefaultMaxResponseBytes,
	}
}

func (c RelayConfig) Validate() error {
	if c.IdleTimeout <= 0 || c.IdleTimeout > DefaultIdleTimeout {
		return errors.New("relay idle timeout must be positive and no more than 30 seconds")
	}
	if c.MaxRequestBytes <= 0 || c.MaxRequestBytes > DefaultMaxRequestBytes {
		return errors.New("relay request limit must be positive and no more than 2 MiB")
	}
	if c.MaxResponseBytes <= 0 || c.MaxResponseBytes > DefaultMaxResponseBytes {
		return errors.New("relay response limit must be positive and no more than 20 MiB")
	}
	return nil
}

type RelayResult struct {
	RequestBytes  int64
	ResponseBytes int64
	Reason        RelayReason
}

type relayDirectionResult struct {
	direction string
	bytes     int64
	reason    RelayReason
}

type deadlinePair struct {
	mu       sync.Mutex
	client   net.Conn
	upstream net.Conn
	idle     time.Duration
}

func (d *deadlinePair) refresh() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	deadline := time.Now().Add(d.idle)
	if err := d.client.SetDeadline(deadline); err != nil {
		return err
	}
	if err := d.upstream.SetDeadline(deadline); err != nil {
		return err
	}
	return nil
}

func Relay(ctx context.Context, client, upstream net.Conn, config RelayConfig) RelayResult {
	if client == nil || upstream == nil || config.Validate() != nil {
		return RelayResult{Reason: RelayFailure}
	}
	deadlines := &deadlinePair{client: client, upstream: upstream, idle: config.IdleTimeout}
	if err := deadlines.refresh(); err != nil {
		return RelayResult{Reason: RelayFailure}
	}

	watchDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = client.Close()
			_ = upstream.Close()
		case <-watchDone:
		}
	}()

	results := make(chan relayDirectionResult, 2)
	go relayDirection(results, "request", upstream, client, config.MaxRequestBytes, RelayUploadLimit, deadlines)
	go relayDirection(results, "response", client, upstream, config.MaxResponseBytes, RelayResponseLimit, deadlines)

	first := <-results
	if first.reason != RelayAllowed {
		_ = client.Close()
		_ = upstream.Close()
	}
	second := <-results
	close(watchDone)
	_ = client.SetDeadline(time.Time{})
	_ = upstream.SetDeadline(time.Time{})

	result := RelayResult{Reason: selectRelayReason(ctx, first.reason, second.reason)}
	for _, direction := range []relayDirectionResult{first, second} {
		if direction.direction == "request" {
			result.RequestBytes = direction.bytes
		} else {
			result.ResponseBytes = direction.bytes
		}
	}
	return result
}

func relayDirection(
	results chan<- relayDirectionResult,
	direction string,
	destination net.Conn,
	source net.Conn,
	limit int64,
	limitReason RelayReason,
	deadlines *deadlinePair,
) {
	bytes, reason := copyBounded(destination, source, limit, limitReason, deadlines)
	if reason == RelayAllowed {
		if err := closeWrite(destination); err != nil {
			reason = RelayFailure
		}
		closeRead(source)
	}
	results <- relayDirectionResult{direction: direction, bytes: bytes, reason: reason}
}

func copyBounded(
	destination net.Conn,
	source net.Conn,
	limit int64,
	limitReason RelayReason,
	deadlines *deadlinePair,
) (int64, RelayReason) {
	buffer := make([]byte, 32<<10)
	var total int64
	for {
		remaining := limit - total
		readSize := int64(len(buffer))
		if remaining < readSize-1 {
			readSize = remaining + 1
		}
		n, readErr := source.Read(buffer[:readSize])
		if int64(n) > remaining {
			return total, limitReason
		}
		if n > 0 {
			if err := deadlines.refresh(); err != nil {
				return total, RelayFailure
			}
			written, writeErr := writeAll(destination, buffer[:n], deadlines)
			total += int64(written)
			if writeErr != nil {
				return total, classifyRelayError(writeErr)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return total, RelayAllowed
			}
			return total, classifyRelayError(readErr)
		}
	}
}

func writeAll(destination net.Conn, buffer []byte, deadlines *deadlinePair) (int, error) {
	written := 0
	for written < len(buffer) {
		n, err := destination.Write(buffer[written:])
		written += n
		if n > 0 {
			if deadlineErr := deadlines.refresh(); deadlineErr != nil {
				return written, deadlineErr
			}
		}
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrUnexpectedEOF
		}
	}
	return written, nil
}

func closeWrite(connection net.Conn) error {
	type closeWriter interface {
		CloseWrite() error
	}
	if value, ok := connection.(closeWriter); ok {
		return value.CloseWrite()
	}
	return errors.New("connection does not support half-close")
}

func closeRead(connection net.Conn) {
	type closeReader interface {
		CloseRead() error
	}
	if value, ok := connection.(closeReader); ok {
		_ = value.CloseRead()
	}
}

func classifyRelayError(err error) RelayReason {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return RelayIdleTimeout
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return RelayIdleTimeout
	}
	return RelayFailure
}

func selectRelayReason(ctx context.Context, reasons ...RelayReason) RelayReason {
	for _, reason := range reasons {
		if reason == RelayUploadLimit || reason == RelayResponseLimit {
			return reason
		}
	}
	for _, reason := range reasons {
		if reason == RelayIdleTimeout {
			return reason
		}
	}
	if ctx.Err() != nil {
		return RelayCancelled
	}
	for _, reason := range reasons {
		if reason != RelayAllowed {
			return RelayFailure
		}
	}
	return RelayAllowed
}
