FROM eclipse-temurin:21-jre

# Install Node 20 and Firebase CLI
RUN apt-get update && apt-get install -y curl ca-certificates gnupg && \
	curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
	apt-get install -y nodejs && \
	npm install -g firebase-tools@latest && \
	rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . /workspace
EXPOSE 8080 5001 4000
COPY start-emulators.sh /usr/local/bin/start-emulators.sh
RUN chmod +x /usr/local/bin/start-emulators.sh
ENTRYPOINT ["sh", "/usr/local/bin/start-emulators.sh"]
