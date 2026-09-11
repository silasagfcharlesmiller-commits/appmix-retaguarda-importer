package frontend

import "embed"

// Assets contém somente arquivos estáticos; Node não é necessário no build nem no cliente.
//
//go:embed dist/*
var Assets embed.FS
