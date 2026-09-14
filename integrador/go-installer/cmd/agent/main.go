package main

import (
	"fmt"
	"os"
	"strconv"

	"appmix/integrador-installer/internal/agent"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "probe" {
		if err := agent.ProbeCredential(); err != nil {
			os.Exit(2)
		}
		fmt.Print("mix-agent-probe-ok")
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "update" {
		id, err := strconv.ParseInt(os.Args[2], 10, 64)
		if err == nil && id > 0 {
			if agent.RunUpdate(id) != nil {
				os.Exit(1)
			}
		}
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "service" {
		return
	}
	_ = agent.RunService()
}
