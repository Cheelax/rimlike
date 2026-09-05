# Déployer le serveur relais + monde

Ce dossier contient tout ce qu'il faut pour faire tourner `apps/server` (relais
WebSocket + serveur monde, voir `docs/protocol.md`) dans un conteneur. Le
serveur ne simule rien : il numérote les ticks, ordonne les commandes et sert
la géométrie du globe (`GET /world`).

## Construire l'image

Le contexte de build est la **racine du dépôt** (l'image compile aussi
`@rimlike/protocol` et `@rimlike/world`, en TypeScript brut, voir les
commentaires de `apps/server/Dockerfile` pour le détail du choix `tsc`) :

```bash
cd /chemin/vers/rimlike
docker build -f apps/server/Dockerfile -t rimlike-server .
```

Ou, depuis ce dossier, avec Docker Compose (qui pointe déjà `context: ..`) :

```bash
cd deploy
docker compose up -d --build
```

## Lancer

Avec `docker run` directement :

```bash
docker run -d \
  --name rimlike-server \
  -p 8787:8787 \
  -v rimlike-world-data:/data \
  -e WORLD_SUBDIVISIONS=5 \
  --restart unless-stopped \
  rimlike-server
```

Ou `docker compose up -d` (voir `docker-compose.yml`, qui documente en
commentaire chaque variable et son défaut). Le service écoute sur le port
`8787`, et un volume nommé (`rimlike-world-data`) porte l'état du monde.

## Vérifier que ça tourne

```bash
curl -s http://localhost:8787/health | jq .
```

Réponse attendue (extrait, voir `apps/server/src/server.ts`) :

```json
{
  "ok": true,
  "rooms": 0,
  "world": { "seed": 1, "subdivisions": 4, "tiles": 2562, "settlements": 0 },
  "persistence": { "enabled": true, "file": "/data/world-state.json", "lastSavedAt": null }
}
```

`lastSavedAt` reste `null` tant qu'aucune colonie n'a encore déclenché de
sauvegarde. Le `HEALTHCHECK` du conteneur (`docker ps`, colonne `STATUS`)
tape la même route toutes les 30 s.

`GET /world` renvoie la géométrie complète du globe (cases, biomes) au format
`WorldWire` — volumineux (plusieurs Mo à `WORLD_SUBDIVISIONS=5`), gzippé et
mis en cache une heure côté client :

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download} octets\n" http://localhost:8787/world
```

## Où sont les données

Un seul fichier JSON, `WORLD_STATE_FILE` (défaut dans l'image :
`/data/world-state.json`), qui porte tout l'état du monde : colonies,
joueurs, caravanes en route (voir `apps/server/src/persistence.ts`). Il est
écrit de façon atomique (`.tmp` puis renommage) et au plus une fois toutes
les 2 s malgré des événements rapprochés.

Avec le volume nommé `rimlike-world-data` :

```bash
docker volume inspect rimlike-world-data   # emplacement réel sur l'hôte
docker exec rimlike-server cat /data/world-state.json | jq .
```

**Sauvegarder** : le plus simple est de copier le fichier pendant que le
serveur tourne (l'écriture atomique garantit qu'on ne lit jamais un JSON à
moitié écrit) :

```bash
docker cp rimlike-server:/data/world-state.json ./backup-$(date +%Y%m%d).json
```

Pour une sauvegarde du volume entier (utile si on ajoute un jour d'autres
fichiers dans `/data`) :

```bash
docker run --rm -v rimlike-world-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rimlike-world-data-$(date +%Y%m%d).tar.gz -C /data .
```

**Restaurer** : arrêter le serveur, remplacer le fichier (ou décompresser
l'archive dans le volume), relancer.

## Changer le globe

`WORLD_SEED` et `WORLD_SUBDIVISIONS` déterminent entièrement la géométrie du
globe et ses biomes (générés au démarrage, jamais stockés indépendamment du
fichier d'état). Les **changer sur un serveur qui a déjà un fichier
`world-state.json`** rend ce fichier inutilisable : les colonies existantes
référencent des cases d'un globe qui n'existe plus. `persistence.ts` détecte
l'écart (`worldSeed`/`subdivisions` du fichier ≠ ceux régénérés) et **met le
fichier en quarantaine** plutôt que de le supprimer ou de deviner un état
à moitié cohérent — il est renommé
`world-state.json.ignored-<horodatage>.json`, resté consultable, et le
serveur repart d'un monde vide avec les nouveaux réglages :

```
[monde] fichier d'état pour un autre globe (seed ..., subdivision ...) que
celui généré ici (seed ..., subdivision ...) : ... Fichier ignoré et renommé
vers /data/world-state.json.ignored-1735900000000.json
```

C'est voulu et sans danger pour l'exploitant (rien n'est perdu, juste
renommé) — mais ça signifie qu'il n'y a pas de migration automatique d'un
globe vers un autre : décider d'un nouveau `WORLD_SEED`/`WORLD_SUBDIVISIONS`
revient à repartir de zéro pour tout le monde.

## Brancher le client

Le client (`apps/client`, servi séparément — ce dépôt ne fournit pas son
conteneur) se connecte à un serveur distant via l'URL, aucune configuration
en dur :

```
https://mon-client.example/?server=ws://mon-hote:8787&name=alice
```

Pour le monde partagé (voir `AGENTS.md`, section « Essayer le monde
partagé ») :

```
https://mon-client.example/?server=ws://mon-hote:8787&name=alice&world=1
```

## `wss://` derrière un reverse proxy

Le serveur lui-même ne fait que `ws://` en clair (voir `HOST`/`PORT`) : le
TLS et `wss://` se posent devant, au niveau du reverse proxy. Deux exemples
minimaux, à adapter (nom de domaine, certificats) :

**Caddy** (`Caddyfile`) — gère Let's Encrypt tout seul :

```
mon-hote.example {
    reverse_proxy localhost:8787
}
```

**nginx** — upgrade WebSocket explicite (sans les en-têtes `Upgrade`/
`Connection`, la connexion reste bloquée en HTTP simple) :

```nginx
server {
    listen 443 ssl;
    server_name mon-hote.example;

    ssl_certificate     /etc/letsencrypt/live/mon-hote.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mon-hote.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;  # une salle lockstep reste ouverte longtemps
    }
}
```

Le client se connecte alors avec `?server=wss://mon-hote.example` (sans port,
443 par défaut).
