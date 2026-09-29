---
name: php-conventions
description: House rules for PHP services — framework idioms, layering, types, errors, database access, tests, generated code, checks. Use when writing or reviewing PHP code in a project; preloaded by php-developer, read by the reviewer for server-side diffs. The repository's own CLAUDE.md wins where they differ.
---

# PHP conventions

The repository's `CLAUDE.md` and its `.claude/agents/` describe the specific setup; these are the defaults underneath.

## Structure

- Stay inside the framework the repository uses (`composer.json` says which: Laravel, Symfony, Slim, plain PHP). Its way of doing routing, validation, dependency injection, configuration and console commands is the way; do not bring another framework's patterns in.
- Respect the existing layering (typically controller → service / use case → repository or ORM, with request and response DTOs at the edge). A change goes through every layer it needs; a controller does not query the database directly unless the repository already does that everywhere.
- Dependencies come through constructors from the container; no static service locators, no globals, no `new` for services inside business code.
- New code mirrors the closest existing entity or endpoint. Same names, same file split, same test style.

## Code

- PSR-12 formatting, PSR-4 autoloading, `declare(strict_types=1);` in every file where the repository does it (and in all new files when it does anywhere).
- Type everything: parameters, return types, properties; `readonly` and enums where the PHP version allows. No `mixed` where a real type exists, no untyped arrays where a DTO or a typed collection is the pattern.
- Errors are exceptions, not return codes or `false`. Throw the repository's domain exceptions, catch only what you handle, never swallow silently. Let the framework's handler turn exceptions into HTTP responses.
- Database: the ORM or query builder the repository uses, with parameters — never string-concatenated SQL. Migrations are additive and reversible, generated with the framework's tool, one per change.
- Input is validated at the edge (form requests, validators, DTO constraints) before it reaches a service. Output goes through the existing serializer or resource classes.
- Prefer the standard library and what is already in `composer.json`; a new dependency needs a reason. `composer.json` changes go through `composer require` / `composer update <package>` so `composer.lock` stays consistent. Never edit `vendor/` by hand.

## Tests

- The repository's runner and libraries only (PHPUnit or Pest, its factories, fixtures and database strategy). Data providers where there are several cases.
- Unit tests mock at the boundary the repository mocks at (interfaces, HTTP clients), not at the ORM level unless the codebase does. Feature or integration tests use the repository's test database setup.
- A fixed bug gets a regression test that fails before the fix.

## Generated code and checks

- OpenAPI specs, ORM proxies, autoload maps and client SDKs are regenerated with the repository's script and committed; CI usually checks that generation is clean.
- Before reporting done: coding-standard check (`php-cs-fixer` or `phpcs` with the repository's config), static analysis (`phpstan` or `psalm` at the repository's level), unit tests. The repository's `composer check` or equivalent is the reference. When this environment has no PHP, say which checks could not run here; CI runs them.
