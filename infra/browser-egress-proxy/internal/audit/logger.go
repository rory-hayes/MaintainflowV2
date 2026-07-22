package audit

import (
	"encoding/json"
	"errors"
	"io"
	"sync"
)

type Logger struct {
	mu      sync.Mutex
	encoder *json.Encoder
	writer  io.Writer
	failed  bool
}

func NewLogger(writer io.Writer) (*Logger, error) {
	if writer == nil {
		return nil, errors.New("audit writer is required")
	}
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(true)
	return &Logger{encoder: encoder, writer: writer}, nil
}

type writerPreflight interface {
	Preflight() error
}

func (l *Logger) Preflight() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failed {
		return errors.New("audit logger is unhealthy")
	}
	if value, ok := l.writer.(writerPreflight); ok {
		if err := value.Preflight(); err != nil {
			l.failed = true
			return errors.New("audit logger is unhealthy")
		}
	}
	return nil
}

func (l *Logger) Write(event Event) error {
	if err := event.Validate(); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failed {
		return errors.New("audit logger is unhealthy")
	}
	if err := l.encoder.Encode(event); err != nil {
		l.failed = true
		return errors.New("write audit event")
	}
	return nil
}
