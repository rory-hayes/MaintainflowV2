package limits

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func smallConfig() Config {
	return Config{
		GlobalActive: 3, CredentialActive: 2, DestinationActive: 1,
		CredentialPerMinute: 2, CredentialBurst: 2,
		DestinationPerMinute: 1, DestinationBurst: 1,
		MaxCredentialStates: 2, MaxDestinationStates: 2,
		StateIdleRetention: time.Minute,
	}
}

func TestDefaultLimitsMatchReviewedContract(t *testing.T) {
	t.Parallel()
	config := DefaultConfig()
	if config.GlobalActive != 64 || config.CredentialActive != 32 || config.DestinationActive != 8 ||
		config.CredentialPerMinute != 120 || config.CredentialBurst != 20 ||
		config.DestinationPerMinute != 60 || config.DestinationBurst != 10 {
		t.Fatalf("default limits drifted: %+v", config)
	}
}

func TestLimiterConcurrencyAndIdempotentRelease(t *testing.T) {
	t.Parallel()
	limiter, err := New(smallConfig())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_000, 0)
	first, reason := limiter.Acquire(now, "credential-a", "one.example.com")
	if reason != ReasonAllowed {
		t.Fatal(reason)
	}
	if _, reason := limiter.Acquire(now, "credential-b", "one.example.com"); reason != ReasonDestinationConcurrency {
		t.Fatalf("destination concurrency reason = %s", reason)
	}
	second, reason := limiter.Acquire(now, "credential-a", "two.example.com")
	if reason != ReasonAllowed {
		t.Fatal(reason)
	}
	if _, reason := limiter.Acquire(now, "credential-a", "three.example.com"); reason != ReasonCredentialConcurrency {
		t.Fatalf("credential concurrency reason = %s", reason)
	}
	first.Release()
	first.Release()
	second.Release()
	global, _, _ := limiter.Snapshot()
	if global != 0 {
		t.Fatalf("active tunnels = %d", global)
	}
}

func TestLimiterRateRefill(t *testing.T) {
	t.Parallel()
	config := smallConfig()
	config.DestinationActive = 3
	limiter, _ := New(config)
	now := time.Unix(2_000, 0)
	lease, reason := limiter.Acquire(now, "credential-a", "one.example.com")
	if reason != ReasonAllowed {
		t.Fatal(reason)
	}
	lease.Release()
	if _, reason := limiter.Acquire(now, "credential-a", "one.example.com"); reason != ReasonDestinationRate {
		t.Fatalf("immediate second destination token reason = %s", reason)
	}
	lease, reason = limiter.Acquire(now.Add(time.Minute), "credential-a", "one.example.com")
	if reason != ReasonAllowed {
		t.Fatalf("refilled token reason = %s", reason)
	}
	lease.Release()
}

func TestLimiterBoundsAndEvictsInactiveState(t *testing.T) {
	t.Parallel()
	config := smallConfig()
	config.CredentialBurst = 10
	config.CredentialPerMinute = 10
	config.DestinationBurst = 10
	config.DestinationPerMinute = 10
	limiter, _ := New(config)
	now := time.Unix(3_000, 0)
	for index := 0; index < 4; index++ {
		lease, reason := limiter.Acquire(now.Add(time.Duration(index)*time.Second), "credential-a", fmt.Sprintf("host-%d.example.com", index))
		if reason != ReasonAllowed {
			t.Fatalf("acquire %d reason = %s", index, reason)
		}
		lease.Release()
	}
	_, _, destinations := limiter.Snapshot()
	if destinations != config.MaxDestinationStates {
		t.Fatalf("destination state size = %d", destinations)
	}
}

func TestLimiterRaceSafety(t *testing.T) {
	config := DefaultConfig()
	config.CredentialPerMinute = 100_000
	config.CredentialBurst = 100_000
	config.DestinationPerMinute = 100_000
	config.DestinationBurst = 100_000
	limiter, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(4_000, 0)
	var wait sync.WaitGroup
	for index := 0; index < 500; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			lease, reason := limiter.Acquire(now, fmt.Sprintf("credential-%d", index%4), fmt.Sprintf("host-%d.example.com", index%16))
			if reason == ReasonAllowed {
				lease.Release()
			}
		}(index)
	}
	wait.Wait()
	global, _, _ := limiter.Snapshot()
	if global != 0 {
		t.Fatalf("race test leaked %d leases", global)
	}
}
