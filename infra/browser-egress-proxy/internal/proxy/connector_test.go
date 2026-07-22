package proxy

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
)

func TestExactConnectorPassesSelectedNumericAddressOnce(t *testing.T) {
	t.Parallel()
	wanted := netip.MustParseAddrPort("93.184.216.34:443")
	peer, other := net.Pipe()
	defer peer.Close()
	defer other.Close()
	calls := 0
	connector, err := newExactConnector(func(_ context.Context, network, address string) (net.Conn, error) {
		calls++
		if network != "tcp" || address != wanted.String() {
			t.Fatalf("dial = %s %s", network, address)
		}
		return peer, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := connector.Connect(context.Background(), wanted)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if calls != 1 {
		t.Fatalf("dial calls = %d", calls)
	}
}

func TestExactConnectorRejectsUnsafeOrWrongPortWithoutDial(t *testing.T) {
	t.Parallel()
	calls := 0
	connector, _ := newExactConnector(func(context.Context, string, string) (net.Conn, error) {
		calls++
		return nil, errors.New("unexpected")
	})
	for _, address := range []netip.AddrPort{
		netip.MustParseAddrPort("127.0.0.1:443"),
		netip.MustParseAddrPort("[fec0::1]:443"),
		netip.MustParseAddrPort("93.184.216.34:80"),
	} {
		if _, err := connector.Connect(context.Background(), address); err == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	if calls != 0 {
		t.Fatalf("unsafe addresses reached dial %d times", calls)
	}
}

func TestExactConnectorDoesNotRetry(t *testing.T) {
	t.Parallel()
	calls := 0
	connector, _ := newExactConnector(func(context.Context, string, string) (net.Conn, error) {
		calls++
		return nil, errors.New("refused")
	})
	_, err := connector.Connect(context.Background(), netip.MustParseAddrPort("93.184.216.34:443"))
	if err == nil || calls != 1 {
		t.Fatalf("err = %v, calls = %d", err, calls)
	}
}
