# One image, three roles: `platform serve` (API + web + MCP + webhooks), `platform worker`, and the CLI.
FROM oven/bun:1.3-debian AS base
ARG DOTNET_CHANNEL=10.0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tar util-linux "$(apt-cache search --names-only '^libicu[0-9]+$' | awk '{print $1}' | head -1)" && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet \
 && bash /tmp/dotnet-install.sh --channel ${DOTNET_CHANNEL} --install-dir /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet && rm /tmp/dotnet-install.sh
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 VOGOBAN_DATA_DIR=/data VOGOBAN_DB=/data/graph.db VOGOBAN_LOG_FORMAT=json
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY semantic ./semantic
COPY policies ./policies
# Prebuild the Roslyn analyzer so workers never compile at runtime.
RUN dotnet build semantic/Vogoban.Roslyn -c Release --nologo -v q \
 && bun -e 'const { roslynBackend } = await import("./src/dotnet/roslyn.ts"); await Bun.write("semantic/Vogoban.Roslyn/bin/.source-hash", roslynBackend.version)'
RUN useradd --uid 10001 --create-home vogoban && mkdir -p /data && chown -R vogoban /data /app/semantic
USER vogoban
VOLUME ["/data"]
EXPOSE 8080
# `platform serve` listens on 8080; `platform worker` serves health on VOGOBAN_WORKER_HEALTH_PORT (9464): set VOGOBAN_HEALTHCHECK_PORT=9464 on worker containers.
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS "http://localhost:${VOGOBAN_HEALTHCHECK_PORT:-8080}/health/live" || exit 1
ENTRYPOINT ["bun", "src/cli/main.ts"]
CMD ["platform", "serve"]
