FROM postgres:16-alpine

# Bake init scripts into the image. They run on first container start
# (when /var/lib/postgresql/data is empty), exactly the same way
# /docker-entrypoint-initdb.d works in the local docker-compose flow —
# the only difference is that here the scripts live in the image instead
# of being bind-mounted from the host.
COPY init/ /docker-entrypoint-initdb.d/
