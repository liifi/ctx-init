# ctx-init

### Purpose

Simple init for containers. Forked from [go-init](https://github.com/adambkaplan/go-init/blob/main/README.md)

### Difference with go-init?

- It removes the need for `-main`
- It adds non-ideal logic (ideally use proper SDKs in app)
    - Ability to load secrets into env vars from AWS Secret Manager.

## Usage

Download the binary `ctx-init` from releases

```bash
# as a simple init
ctx-init -- my_command param1 param2

# as a simple init with pre and post commands
ctx-init -pre "my_pre_command param1" -post "my_post_command param1" -- my_command param1 param2

# as a simple init with injected secrets
SOME_SECRET=aws:sm:::test/hello \
  ctx-init -- echo "\$SOME_SECRET"

# as a simple init with debug log level
LOG_LEVEL=debug \
ctx-init -- my_command param1 param2

# as a simple init with json output
LOG_OUTPUT=json \
ctx-init -- my_command param1 param2
```