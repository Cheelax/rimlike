# syntax=docker/dockerfile:1
#
# Image du serveur relais + monde (apps/server). Le contexte de build est la
# RACINE du dépôt : @rimlike/protocol et @rimlike/world (workspace pnpm, TS
# brut) doivent être visibles à côté de apps/server.
#
#   docker build -f apps/server/Dockerfile -t rimlike-server .
#
# Choix de compilation : tsc vers dist/, pas de tsx en production
# -----------------------------------------------------------------------
# @rimlike/protocol et @rimlike/world exportent directement leurs sources
# TypeScript ("exports": { ".": "./src/index.ts" } dans leurs package.json) :
# en développement, tsx les transpile à la volée à chaque import. Embarquer
# tsx (et le compilateur TypeScript complet) dans l'image finale seulement
# pour ça est évitable : apps/server/tsconfig.build.json compile en une seule
# passe apps/server/src ET les deux paquets workspace (inclus explicitement
# par leur chemin, rootDir remonté à la racine du dépôt pour que tsc ait le
# droit de les émettre — sinon TS6059, "File is not under 'rootDir'") vers
# dist/, qui reproduit l'arborescence du dépôt :
#
#   dist/apps/server/src/*.js        (point d'entrée : dist/apps/server/src/index.js)
#   dist/packages/protocol/src/*.js
#   dist/packages/world/src/*.js
#
# tsc ne réécrit jamais un spécificateur d'import nu : les "@rimlike/protocol"
# et "@rimlike/world" restent tels quels dans le JS émis. `pnpm run
# build:server` (apps/server/package.json) dépose donc aussi deux minuscules
# package.json de redirection dans dist/node_modules/@rimlike/{protocol,world}/,
# dont le seul rôle est de faire pointer "main" vers le .js compilé du paquet
# frère, à l'intérieur de dist/ lui-même (chemin relatif, dist/ est donc un
# résultat autonome, indépendant de où il est copié ensuite). Node résout un
# import depuis le node_modules le plus proche du fichier qui importe : celui
# de dist/ est trouvé avant tout node_modules plus haut, donc les liens
# symboliques pnpm vers les *sources* TypeScript des paquets workspace
# (présents dans node_modules mais inutilisables tels quels par un node nu)
# ne sont jamais consultés à l'exécution — même s'ils restent dans l'image,
# potentiellement pendants. Résultat : l'image finale ne lance que `node`,
# sans TypeScript ni tsx, et sans devDependencies.
#
# Quatre étapes : dépendances complètes (pour compiler), compilation,
# dépendances de production seules (ici : juste "ws", @rimlike/protocol et
# @rimlike/world n'ont aucune dépendance runtime), puis l'image d'exécution.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.11.0

# --- deps : dépendances complètes du filtre "server..." (le paquet et tout
# ce dont il dépend : @rimlike/protocol, @rimlike/world) ---------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# Seuls les manifestes d'abord : le cache Docker de cette couche survit à
# toute modification qui ne touche pas les dépendances.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/world/package.json packages/world/package.json
RUN pnpm install --frozen-lockfile --filter server...

# --- build : compilation tsc de apps/server + des deux paquets workspace ----
FROM deps AS build
COPY apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/
COPY apps/server/src apps/server/src
COPY packages/protocol/src packages/protocol/src
COPY packages/world/src packages/world/src
RUN pnpm --filter server run build:server

# --- deps-prod : les mêmes manifestes, sans devDependencies (tsx, typescript,
# vitest, @types/*...) : c'est ce qui part réellement dans l'image finale ----
FROM ${NODE_IMAGE} AS deps-prod
ARG PNPM_VERSION
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/world/package.json packages/world/package.json
# node-linker=hoisted : de vrais répertoires à la racine de /repo/node_modules
# (ws en tête) au lieu de liens symboliques vers un dépôt .pnpm qui ne serait
# pas copié dans l'image. Les liens vers les paquets workspace y restent
# pendants, mais dist/node_modules/@rimlike/* est trouvé avant eux.
RUN pnpm install --frozen-lockfile --prod --filter server... --config.node-linker=hoisted

# --- runtime : image finale, minimale ---------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Utilisateur non-root, et /data créé et possédé par lui avant VOLUME : un
# volume nommé fraîchement créé hérite du contenu/droits du point de montage
# tel qu'il existait dans l'image à ce moment-là.
RUN addgroup -S rimlike && adduser -S rimlike -G rimlike \
    && mkdir -p /data \
    && chown -R rimlike:rimlike /data /app

COPY --from=deps-prod --chown=rimlike:rimlike /repo/node_modules ./node_modules
COPY --from=build --chown=rimlike:rimlike /repo/apps/server/dist ./dist

# Défauts alignés sur docs/protocol.md et apps/server/src/index.ts. Le reste
# des variables (WORLD_SEED, WORLD_SUBDIVISIONS, WORLD_HOUR_MS,
# CARAVAN_TICK_MS...) garde ses défauts applicatifs tant qu'il n'est pas
# fourni à `docker run`/docker-compose — voir apps/server/README.md.
ENV WORLD_STATE_FILE=/data/world-state.json \
    PORT=8787 \
    HOST=0.0.0.0

EXPOSE 8787
VOLUME ["/data"]

USER rimlike

# Pas de curl/wget garanti sur alpine : un GET /health fait avec node lui-même.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||8787,path:'/health',timeout:3000},(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/apps/server/src/index.js"]
