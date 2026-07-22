package config

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net/url"
	"os"
	"time"
)

const maximumTLSFileBytes = 1 << 20

func ServerTLSConfig(certificateFile, keyFile, clientCAFile, allowedClientURI string) (*tls.Config, error) {
	certificatePEM, err := readBoundedFile(certificateFile)
	if err != nil {
		return nil, errors.New("load dialer server certificate")
	}
	keyPEM, err := readBoundedFile(keyFile)
	if err != nil {
		return nil, errors.New("load dialer server key")
	}
	certificate, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil || len(certificate.Certificate) == 0 {
		return nil, errors.New("load dialer server identity")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) || !permitsUsage(leaf, x509.ExtKeyUsageServerAuth) {
		return nil, errors.New("dialer server certificate is invalid or expired")
	}
	certificate.Leaf = leaf

	caPEM, err := readBoundedFile(clientCAFile)
	if err != nil {
		return nil, errors.New("load dialer client CA")
	}
	clientCAs, err := parseCAPool(caPEM)
	if err != nil {
		return nil, err
	}
	allowedURI, err := url.Parse(allowedClientURI)
	if err != nil || allowedURI.Scheme != "spiffe" || allowedURI.Host == "" || allowedURI.String() != allowedClientURI {
		return nil, errors.New("invalid allowed client identity")
	}

	configuration := &tls.Config{
		Certificates:           []tls.Certificate{certificate},
		ClientCAs:              clientCAs,
		ClientAuth:             tls.RequireAndVerifyClientCert,
		MinVersion:             tls.VersionTLS12,
		NextProtos:             []string{"http/1.1"},
		SessionTicketsDisabled: true,
	}
	configuration.VerifyConnection = func(state tls.ConnectionState) error {
		if state.NegotiatedProtocol != "http/1.1" || len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
			return errors.New("authenticated HTTP/1.1 client identity is required")
		}
		leaf := state.PeerCertificates[0]
		if !permitsUsage(leaf, x509.ExtKeyUsageClientAuth) || len(leaf.URIs) != 1 || leaf.URIs[0].String() != allowedClientURI {
			return errors.New("client identity is not allowlisted")
		}
		return nil
	}
	return configuration, nil
}

func ClientIdentity(state tls.ConnectionState) (string, error) {
	if !state.HandshakeComplete || state.NegotiatedProtocol != "http/1.1" || len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		return "", errors.New("verified client identity is required")
	}
	leaf := state.PeerCertificates[0]
	if len(leaf.URIs) != 1 || leaf.URIs[0] == nil {
		return "", errors.New("one client URI identity is required")
	}
	return leaf.URIs[0].String(), nil
}

func parseCAPool(contents []byte) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	count := 0
	for len(contents) > 0 {
		block, remainder := pem.Decode(contents)
		if block == nil {
			return nil, errors.New("client CA bundle contains invalid PEM")
		}
		contents = remainder
		if block.Type != "CERTIFICATE" {
			return nil, errors.New("client CA bundle contains a non-certificate block")
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !certificate.IsCA || time.Now().Before(certificate.NotBefore) || !time.Now().Before(certificate.NotAfter) {
			return nil, errors.New("client CA bundle contains an invalid or expired CA")
		}
		pool.AddCert(certificate)
		count++
	}
	if count == 0 {
		return nil, errors.New("client CA bundle is empty")
	}
	return pool, nil
}

func permitsUsage(certificate *x509.Certificate, expected x509.ExtKeyUsage) bool {
	if len(certificate.ExtKeyUsage) == 0 {
		return true
	}
	for _, usage := range certificate.ExtKeyUsage {
		if usage == expected || usage == x509.ExtKeyUsageAny {
			return true
		}
	}
	return false
}

func readBoundedFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, maximumTLSFileBytes+1))
	if err != nil || len(contents) == 0 || len(contents) > maximumTLSFileBytes {
		return nil, errors.New("TLS file is empty or oversized")
	}
	return contents, nil
}
