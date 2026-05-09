package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"

	"github.com/pion/turn/v4"
)

func main() {
	publicIP := flag.String("public-ip", "89.208.74.21", "Public IP of the TURN server")
	port := flag.Int("port", 3478, "TURN server listen port (UDP+TCP)")
	realm := flag.String("realm", "ionik.local", "Authentication realm")
	users := flag.String("users", "ionikuser=ionikturn123", "List of user=password pairs, comma-separated")
	relayMin := flag.Int("relay-min", 49160, "Min relay port")
	relayMax := flag.Int("relay-max", 49200, "Max relay port")
	flag.Parse()

	if *publicIP == "" {
		log.Fatal("public-ip is required")
	}

	// Parse users (RFC 5389 long-term credentials key = MD5(user:realm:pass))
	usersMap := map[string][]byte{}
	re := regexp.MustCompile(`(\w+)=(\S+)`)
	for _, kv := range re.FindAllStringSubmatch(*users, -1) {
		usersMap[kv[1]] = turn.GenerateAuthKey(kv[1], *realm, kv[2])
		log.Printf("user: %s", kv[1])
	}

	// UDP listener
	udpAddr := "0.0.0.0:" + strconv.Itoa(*port)
	udpListener, err := net.ListenPacket("udp4", udpAddr)
	if err != nil {
		log.Fatalf("failed to listen UDP %s: %s", udpAddr, err)
	}

	// TCP listener
	tcpListener, err := net.Listen("tcp4", udpAddr)
	if err != nil {
		log.Fatalf("failed to listen TCP %s: %s", udpAddr, err)
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: *realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			log.Printf("auth: user=%s realm=%s src=%s", username, realm, srcAddr)
			if k, ok := usersMap[username]; ok {
				return k, true
			}
			return nil, false
		},
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
					RelayAddress: net.ParseIP(*publicIP),
					Address:      "0.0.0.0",
					MinPort:      uint16(*relayMin),
					MaxPort:      uint16(*relayMax),
				},
			},
		},
		ListenerConfigs: []turn.ListenerConfig{
			{
				Listener: tcpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
					RelayAddress: net.ParseIP(*publicIP),
					Address:      "0.0.0.0",
					MinPort:      uint16(*relayMin),
					MaxPort:      uint16(*relayMax),
				},
			},
		},
	})
	if err != nil {
		log.Fatalf("turn.NewServer failed: %s", err)
	}

	fmt.Println("==================================================")
	fmt.Printf(" pion TURN server listening on %s (UDP+TCP)\n", udpAddr)
	fmt.Printf(" public IP    : %s\n", *publicIP)
	fmt.Printf(" realm        : %s\n", *realm)
	fmt.Printf(" relay ports  : %d-%d UDP\n", *relayMin, *relayMax)
	fmt.Println("==================================================")

	// Block until interrupt
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	if err := server.Close(); err != nil {
		log.Printf("server.Close: %s", err)
	}
}
