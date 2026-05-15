# postgres-seeded image
#
# Build-time: spin up a throwaway postgres inside the build stage,
# apply the init/*.sql scripts, then `pg_dump` the database to a single
# plain-SQL file. Bake that dump file into the final image as
# /docker-entrypoint-initdb.d/00-seed.sql.
#
# Runtime: a fresh container with an empty data dir runs the standard
# postgres entrypoint, which executes 00-seed.sql via psql to restore
# the baked dump. No init scripts re-execute, no seed logic re-runs;
# we just replay what pg_dump captured.
#
# The local docker-compose.yml flow is unchanged — it bind-mounts
# postgres/init/ directly so dev iteration on the SQL stays cheap.
# This image is only built+pushed by scripts/build-and-push.ps1.

# ---------- Stage 1: produce the dump ----------
FROM postgres:16-alpine AS dump-builder

ENV POSTGRES_USER=ephemeral \
    POSTGRES_DB=ephemeral \
    PGDATA=/var/lib/postgresql/data

# Copy init scripts into a scratch location (NOT into
# /docker-entrypoint-initdb.d/ — we drive them manually below so we
# can dump immediately after).
COPY init/ /tmp/init/

RUN set -eux; \
    mkdir -p "$PGDATA" /tmp/dump; \
    chown -R postgres:postgres "$PGDATA" /tmp/init /tmp/dump; \
    \
    # Initialize an empty cluster as the postgres OS user.
    gosu postgres initdb -D "$PGDATA" --username="$POSTGRES_USER" --auth-local=trust --auth-host=trust; \
    \
    # Start postgres on a unix socket only — no TCP, no network exposure
    # during build.
    gosu postgres pg_ctl -D "$PGDATA" \
      -o "-c listen_addresses='' -c unix_socket_directories=/tmp" \
      -w start; \
    \
    # Create the application database, then apply each init script in
    # lexical order, just like the standard entrypoint would.
    gosu postgres psql -h /tmp -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$POSTGRES_DB\""; \
    for f in /tmp/init/*.sql; do \
      echo "==> applying $f"; \
      gosu postgres psql -h /tmp -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v ON_ERROR_STOP=1 -f "$f"; \
    done; \
    \
    # Dump the resulting database as a single plain-SQL file. Using
    # --no-owner / --no-privileges so the restore is portable across
    # role names if we ever change POSTGRES_USER.
    gosu postgres pg_dump -h /tmp -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --format=plain --no-owner --no-privileges \
      --file=/tmp/dump/seed.sql; \
    \
    gosu postgres pg_ctl -D "$PGDATA" -m fast -w stop; \
    \
    echo "==> dump size:"; ls -lh /tmp/dump/seed.sql

# ---------- Stage 2: final runtime image ----------
FROM postgres:16-alpine

# Drop the dump into the standard init directory. Postgres' entrypoint
# will replay it on first start (when PGDATA is empty), restoring
# schema + seed data exactly as captured at build time.
COPY --from=dump-builder /tmp/dump/seed.sql /docker-entrypoint-initdb.d/00-seed.sql
