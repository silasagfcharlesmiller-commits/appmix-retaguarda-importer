package main

import (
	"os"

	"appmix/integrador-installer/internal/agent"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "service" {
		return
	}
	_ = agent.RunService()
}
