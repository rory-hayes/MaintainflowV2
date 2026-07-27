package proxy

import (
	"bytes"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"maintainflow/browser-egress-proxy/internal/authority"
)

const (
	DefaultMaxConnectHeaderBytes = 64 << 10
	DefaultConnectHeaderTimeout  = 5 * time.Second
)

type RequestReason string

const (
	RequestInvalidAuthority RequestReason = "invalid_authority"
	RequestUnsupported      RequestReason = "unsupported_protocol"
	RequestBodyNotAllowed   RequestReason = "body_not_allowed"
	RequestHeaderLimit      RequestReason = "header_limit"
	RequestHeaderTimeout    RequestReason = "header_timeout"
)

type RequestError struct {
	Reason RequestReason
}

func (e *RequestError) Error() string {
	return string(e.Reason)
}

type ConnectRequest struct {
	Hostname string
}

// ReadConnectRequest reads exactly one bounded HTTP/1.1 CONNECT header block.
// It deliberately does not use net/http: http.Server's MaxHeaderBytes allows
// parser slop and its request machinery accepts forms that do not belong on
// this private, single-purpose protocol boundary.
func ReadConnectRequest(connection net.Conn, maximum int, timeout time.Duration) (ConnectRequest, error) {
	if connection == nil || maximum <= 0 || maximum > DefaultMaxConnectHeaderBytes ||
		timeout <= 0 || timeout > DefaultConnectHeaderTimeout {
		return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
	}
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return ConnectRequest{}, &RequestError{Reason: RequestHeaderTimeout}
	}
	defer connection.SetReadDeadline(time.Time{}) //nolint:errcheck -- connection failure already fails the request.

	buffer := make([]byte, maximum)
	used := 0
	for {
		if used == maximum {
			return ConnectRequest{}, &RequestError{Reason: RequestHeaderLimit}
		}
		read, err := connection.Read(buffer[used:])
		if read > 0 {
			used += read
			if end := bytes.Index(buffer[:used], []byte("\r\n\r\n")); end >= 0 {
				end += 4
				// A body, target TLS preface, or second request received before the
				// CONNECT response is never carried forward to the target.
				if end != used {
					return ConnectRequest{}, &RequestError{Reason: RequestBodyNotAllowed}
				}
				queued, probeErr := probePreResponseBytes(connection)
				if queued {
					return ConnectRequest{}, &RequestError{Reason: RequestBodyNotAllowed}
				}
				if probeErr != nil {
					return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
				}
				return ParseConnectRequest(buffer[:end])
			}
		}
		if err != nil {
			if isTimeout(err) {
				return ConnectRequest{}, &RequestError{Reason: RequestHeaderTimeout}
			}
			if errors.Is(err, io.EOF) {
				return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
			}
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		if read == 0 {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
	}
}

func probePreResponseBytes(connection net.Conn) (bool, error) {
	// A compliant CONNECT client waits for the 200 response before sending its
	// target TLS preface. This short non-buffering probe closes the exact-header-
	// limit edge case where the first read filled the 64 KiB buffer while a body
	// or second request was already queued behind it.
	if err := connection.SetReadDeadline(time.Now().Add(time.Millisecond)); err != nil {
		return false, err
	}
	var extra [1]byte
	read, err := connection.Read(extra[:])
	if read > 0 {
		return true, nil
	}
	if isTimeout(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return false, errors.New("zero-byte pre-response read")
}

// ParseConnectRequest accepts only the canonical internal request form:
// CONNECT normalized-host:443 HTTP/1.1 with one matching Host field.
func ParseConnectRequest(raw []byte) (ConnectRequest, error) {
	if len(raw) == 0 || len(raw) > DefaultMaxConnectHeaderBytes {
		return ConnectRequest{}, &RequestError{Reason: RequestHeaderLimit}
	}
	if !bytes.HasSuffix(raw, []byte("\r\n\r\n")) || bytes.Count(raw, []byte("\r\n\r\n")) != 1 {
		return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
	}
	for index, value := range raw {
		if value >= 0x7f || value == 0 || value == '\v' || value == '\f' ||
			(value < 0x20 && value != '\r' && value != '\n' && value != '\t') ||
			(value == '\n' && (index == 0 || raw[index-1] != '\r')) {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
	}

	lines := bytes.Split(raw[:len(raw)-4], []byte("\r\n"))
	if len(lines) < 2 {
		return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
	}
	requestLine := string(lines[0])
	parts := strings.Split(requestLine, " ")
	if len(parts) != 3 || parts[0] != "CONNECT" || parts[2] != "HTTP/1.1" {
		return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
	}
	hostname, err := authority.ParseConnectAuthority(parts[1])
	if err != nil || parts[1] != hostname+":443" {
		return ConnectRequest{}, &RequestError{Reason: RequestInvalidAuthority}
	}

	seen := make(map[string]struct{}, len(lines)-1)
	hostValue := ""
	for _, rawLine := range lines[1:] {
		if len(rawLine) == 0 || rawLine[0] == ' ' || rawLine[0] == '\t' {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		separator := bytes.IndexByte(rawLine, ':')
		if separator <= 0 {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		name := strings.ToLower(string(rawLine[:separator]))
		if !validHeaderName(name) {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		if _, duplicate := seen[name]; duplicate {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		seen[name] = struct{}{}
		value := trimOptionalWhitespace(string(rawLine[separator+1:]))
		if strings.ContainsAny(value, "\r\n\x00") {
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
		switch name {
		case "host":
			hostValue = value
		case "content-length", "transfer-encoding", "te", "trailer", "expect":
			return ConnectRequest{}, &RequestError{Reason: RequestBodyNotAllowed}
		case "connection", "proxy-connection", "upgrade", "http2-settings",
			"sec-websocket-key", "sec-websocket-version", "authorization", "proxy-authorization":
			return ConnectRequest{}, &RequestError{Reason: RequestUnsupported}
		}
	}
	if hostValue == "" || hostValue != parts[1] {
		return ConnectRequest{}, &RequestError{Reason: RequestInvalidAuthority}
	}
	return ConnectRequest{Hostname: hostname}, nil
}

func validHeaderName(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') {
			continue
		}
		switch character {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		default:
			return false
		}
	}
	return true
}

func trimOptionalWhitespace(value string) string {
	return strings.Trim(value, " \t")
}

func isTimeout(err error) bool {
	var netError net.Error
	return errors.As(err, &netError) && netError.Timeout()
}
