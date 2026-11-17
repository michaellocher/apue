package main

import (
	"context"
	"errors"
	"fmt"

	"example.com/app/api" // apue-types … --lang go --package api --out api/api.go
)

func main() {
	ctx := context.Background()
	c, err := api.NewClient("https://localhost:8443", api.WithCAFile("cert.pem"))
	if err != nil {
		panic(err)
	}
	defer c.Close()

	todo, err := c.TodosCreate(ctx, api.TodosCreateInput{Title: "buy milk"}) // POST + Idempotency-Key
	if err != nil {
		panic(err)
	}
	fmt.Println(todo.Id, todo.Title)

	var problem *api.Error
	if _, err := c.TodosCreate(ctx, api.TodosCreateInput{Title: ""}); errors.As(err, &problem) {
		fmt.Println(problem.Status, problem.Type) // 400 https://michaellocher.github.io/apue/problems/validation-failed
	}

	stream, err := c.TodosWatch(ctx) // a server stream; leaving the loop cancels it
	if err != nil {
		panic(err)
	}
	for t, err := range stream.All() {
		if err != nil {
			panic(err)
		}
		fmt.Println(t.Title)
	}
}
