package limits

import (
	"errors"
	"sync"
	"time"
)

const (
	DefaultGlobalActive         = 64
	DefaultCredentialActive     = 32
	DefaultDestinationActive    = 8
	DefaultCredentialPerMinute  = 120
	DefaultCredentialBurst      = 20
	DefaultDestinationPerMinute = 60
	DefaultDestinationBurst     = 10
	DefaultMaxCredentialStates  = 128
	DefaultMaxDestinationStates = 4096
	DefaultStateIdleRetention   = 10 * time.Minute
)

type Reason string

const (
	ReasonAllowed                  Reason = "allowed"
	ReasonGlobalConcurrency        Reason = "global_concurrency"
	ReasonCredentialConcurrency    Reason = "credential_concurrency"
	ReasonDestinationConcurrency   Reason = "destination_concurrency"
	ReasonCredentialRate           Reason = "credential_rate"
	ReasonDestinationRate          Reason = "destination_rate"
	ReasonCredentialStateCapacity  Reason = "credential_state_capacity"
	ReasonDestinationStateCapacity Reason = "destination_state_capacity"
)

type Config struct {
	GlobalActive         int
	CredentialActive     int
	DestinationActive    int
	CredentialPerMinute  int
	CredentialBurst      int
	DestinationPerMinute int
	DestinationBurst     int
	MaxCredentialStates  int
	MaxDestinationStates int
	StateIdleRetention   time.Duration
}

func DefaultConfig() Config {
	return Config{
		GlobalActive:         DefaultGlobalActive,
		CredentialActive:     DefaultCredentialActive,
		DestinationActive:    DefaultDestinationActive,
		CredentialPerMinute:  DefaultCredentialPerMinute,
		CredentialBurst:      DefaultCredentialBurst,
		DestinationPerMinute: DefaultDestinationPerMinute,
		DestinationBurst:     DefaultDestinationBurst,
		MaxCredentialStates:  DefaultMaxCredentialStates,
		MaxDestinationStates: DefaultMaxDestinationStates,
		StateIdleRetention:   DefaultStateIdleRetention,
	}
}

func (c Config) Validate() error {
	if c.GlobalActive <= 0 || c.CredentialActive <= 0 || c.DestinationActive <= 0 ||
		c.CredentialActive > c.GlobalActive || c.DestinationActive > c.GlobalActive {
		return errors.New("invalid active tunnel limits")
	}
	if c.CredentialPerMinute <= 0 || c.CredentialBurst <= 0 ||
		c.DestinationPerMinute <= 0 || c.DestinationBurst <= 0 {
		return errors.New("invalid tunnel rate limits")
	}
	if c.MaxCredentialStates <= 0 || c.MaxDestinationStates <= 0 || c.StateIdleRetention <= 0 {
		return errors.New("invalid limiter state bounds")
	}
	return nil
}

type state struct {
	active   int
	tokens   float64
	lastFill time.Time
	lastSeen time.Time
}

type Limiter struct {
	mu           sync.Mutex
	config       Config
	globalActive int
	credentials  map[string]*state
	destinations map[string]*state
}

func New(config Config) (*Limiter, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &Limiter{
		config:       config,
		credentials:  make(map[string]*state),
		destinations: make(map[string]*state),
	}, nil
}

type Lease struct {
	once        sync.Once
	limiter     *Limiter
	credential  string
	destination string
}

func (l *Lease) Release() {
	if l == nil || l.limiter == nil {
		return
	}
	l.once.Do(func() {
		l.limiter.release(l.credential, l.destination)
	})
}

func (l *Limiter) Acquire(now time.Time, credential, destination string) (*Lease, Reason) {
	if credential == "" || destination == "" || now.IsZero() {
		return nil, ReasonCredentialStateCapacity
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked(now)

	credentialState, exists := l.credentials[credential]
	if !exists {
		if len(l.credentials) >= l.config.MaxCredentialStates && !l.evictCredentialLocked() {
			return nil, ReasonCredentialStateCapacity
		}
		credentialState = newState(now, l.config.CredentialBurst)
		l.credentials[credential] = credentialState
	}
	credentialTokens := refillTokens(credentialState, now, l.config.CredentialPerMinute, l.config.CredentialBurst)
	credentialState.lastSeen = now

	if l.globalActive >= l.config.GlobalActive {
		return nil, ReasonGlobalConcurrency
	}
	if credentialState.active >= l.config.CredentialActive {
		return nil, ReasonCredentialConcurrency
	}
	if credentialTokens < 1 {
		return nil, ReasonCredentialRate
	}

	// Do not allocate destination state for requests already rejected by a
	// global or credential limit. Otherwise one saturated credential could fill
	// the bounded destination map with authorities that never reached policy.
	destinationState, exists := l.destinations[destination]
	if !exists {
		if len(l.destinations) >= l.config.MaxDestinationStates && !l.evictDestinationLocked() {
			return nil, ReasonDestinationStateCapacity
		}
		destinationState = newState(now, l.config.DestinationBurst)
		l.destinations[destination] = destinationState
	}
	destinationTokens := refillTokens(destinationState, now, l.config.DestinationPerMinute, l.config.DestinationBurst)
	destinationState.lastSeen = now
	if destinationState.active >= l.config.DestinationActive {
		return nil, ReasonDestinationConcurrency
	}
	if destinationTokens < 1 {
		return nil, ReasonDestinationRate
	}

	credentialState.tokens = credentialTokens - 1
	destinationState.tokens = destinationTokens - 1
	credentialState.active++
	destinationState.active++
	l.globalActive++
	return &Lease{limiter: l, credential: credential, destination: destination}, ReasonAllowed
}

func (l *Limiter) Snapshot() (global int, credentials int, destinations int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.globalActive, len(l.credentials), len(l.destinations)
}

func (l *Limiter) release(credential, destination string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.globalActive > 0 {
		l.globalActive--
	}
	if value := l.credentials[credential]; value != nil && value.active > 0 {
		value.active--
	}
	if value := l.destinations[destination]; value != nil && value.active > 0 {
		value.active--
	}
}

func newState(now time.Time, burst int) *state {
	return &state{tokens: float64(burst), lastFill: now, lastSeen: now}
}

func refillTokens(value *state, now time.Time, perMinute, burst int) float64 {
	if now.Before(value.lastFill) {
		return value.tokens
	}
	elapsed := now.Sub(value.lastFill).Seconds()
	tokens := value.tokens + elapsed*(float64(perMinute)/60)
	if tokens > float64(burst) {
		tokens = float64(burst)
	}
	value.tokens = tokens
	value.lastFill = now
	return tokens
}

func (l *Limiter) pruneLocked(now time.Time) {
	for key, value := range l.credentials {
		if value.active == 0 && now.Sub(value.lastSeen) > l.config.StateIdleRetention {
			delete(l.credentials, key)
		}
	}
	for key, value := range l.destinations {
		if value.active == 0 && now.Sub(value.lastSeen) > l.config.StateIdleRetention {
			delete(l.destinations, key)
		}
	}
}

func (l *Limiter) evictCredentialLocked() bool {
	key, found := oldestInactive(l.credentials)
	if found {
		delete(l.credentials, key)
	}
	return found
}

func (l *Limiter) evictDestinationLocked() bool {
	key, found := oldestInactive(l.destinations)
	if found {
		delete(l.destinations, key)
	}
	return found
}

func oldestInactive(values map[string]*state) (string, bool) {
	var selected string
	var selectedTime time.Time
	for key, value := range values {
		if value.active != 0 {
			continue
		}
		if selected == "" || value.lastSeen.Before(selectedTime) {
			selected = key
			selectedTime = value.lastSeen
		}
	}
	return selected, selected != ""
}
