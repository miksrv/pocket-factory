---
name: go-conventions
description: House rules for Go services — layering, errors, context, tests, generated code, checks. Use when writing or reviewing Go code in a project; preloaded by go-developer, read by the reviewer for server-side diffs. The repository's own CLAUDE.md wins where they differ.
---

# Go conventions

The repository's `CLAUDE.md` and its `.claude/agents/` describe the specific layout; these are the defaults underneath.

## Structure

- Respect the existing layering (typically handler → use case / service → repository, with DTOs at the edge). A change goes through every layer it needs; it does not shortcut from a handler into the database.
- Interfaces and constructors live where the repository puts them (often a `root.go` per layer); mocks are generated from those interfaces.
- New code mirrors the closest existing entity or route. Same names, same file split, same test style.

## Code

- Errors are never ignored. Wrap with context: `fmt.Errorf("loading tenant %s: %w", id, err)`. Compare with `errors.Is` / `errors.As`, not string matching.
- `context.Context` is the first parameter of anything that does I/O and is passed down; never stored in structs.
- Goroutines have an owner and a way to stop (context or channel); every `Lock` has its `defer Unlock`, every opened resource its `defer Close`.
- Prefer the standard library; a new dependency needs a reason. `go.mod` changes go through `go mod tidy` and, if the repository vendors, `go mod vendor`. Never edit `vendor/` by hand.
- Follow the uber-go style guide where the repository does not say otherwise.
- SQL: parameters, never string concatenation; keep the query builder the repository already uses; migrations are additive and reversible.

## Tests

- The repository's libraries only (commonly `testify` with `require` for preconditions and `assert` for checks). Table-driven where there are several cases. `-race` when the Makefile runs with it.
- Unit tests use the generated mocks; integration tests use the repository's container setup and its build tag. Don't invent a third way.
- A fixed bug gets a regression test that fails before the fix.

## Generated code and checks

- API docs annotations on handlers; regenerate docs and mocks with the repository's target (`make generate`, `go generate ./...`) and commit the result. CI usually checks that generation is clean.
- Before reporting done: lint (golangci-lint with the repository's config), `go vet`, unit tests, build. The repository's `make check` or equivalent is the reference.
