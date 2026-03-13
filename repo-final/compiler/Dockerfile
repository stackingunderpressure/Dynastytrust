# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Build context must be the REPO ROOT, not the compiler/ subdirectory.
# Run from repo root: docker build -f compiler/Dockerfile -t dynastytrust-compiler .
# Fly.io uses fly.toml's [build] dockerfile setting with root context automatically.

FROM rust:1-bookworm AS builder
WORKDIR /app

COPY rust-toolchain.toml ./

# Write workspace Cargo.toml inline — Fly.io deploys only compiler/ context
# so the root Cargo.toml is not available. We recreate it here.
RUN printf '[workspace]\nresolver = "2"\nmembers = ["protocol", "compiler"]\n\n[profile.release]\noverflow-checks = true\nopt-level = 3\nlto = true\ncodegen-units = 1\n' > Cargo.toml

# Copy crate manifests
COPY protocol/Cargo.toml ./protocol/
COPY compiler/Cargo.toml ./compiler/

# Stub source files so cargo fetch succeeds
RUN mkdir -p protocol/src compiler/src && \
    echo "" > protocol/src/lib.rs && \
    echo "fn main() {}" > compiler/src/main.rs

RUN cargo fetch

# Copy real source
COPY protocol/src ./protocol/src
COPY compiler/src ./compiler/src

RUN cargo build -p dynastytrust_compiler --release

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/dynastytrust_compiler /app/dynastytrust_compiler

ENV PORT=8080
EXPOSE 8080

CMD ["/app/dynastytrust_compiler"]
