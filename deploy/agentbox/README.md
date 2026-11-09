# Hébergement de test partagé sur agentbox

Le serveur actuel (`apps/server`, inchangé) et le client compilé, servis depuis
la box agentique **agentbox** (Fedora, à la maison) et publiés par un **tunnel
Cloudflare sortant** : pas de VPS, aucun port entrant ouvert, accès filtré par
**Cloudflare Access**. Le reste de `deploy/` (image Docker, Compose) est la
référence générique ; ce dossier n'en est qu'une application à cette machine.

```
navigateur ──https/wss──▶ Cloudflare (Access : e-mail autorisé ?)
                              │ tunnel sortant « rimlike » (cloudflared-rimlike, service système)
                              ▼
agentbox 127.0.0.1:8790 ──▶ pod podman « rimlike » (utilisateur rimlike, sans root)
                              ├─ rimlike-web    Caddy :8080 — client + relais
                              └─ rimlike-server apps/server 127.0.0.1:8787 — volume rimlike-world:/data
```

Tout passe par **une seule origine** (`https://rimlike.zkorp.net`) : la page,
la WebSocket et `GET /world` partagent le cookie Access, sans CORS. Caddy
envoie au serveur l'upgrade WebSocket, `/health`, `/world` et `/rooms`, et sert
le client pour tout le reste.

## URL à partager

```
https://rimlike.zkorp.net/?server=wss://rimlike.zkorp.net&world=1
```

Chaque joueur s'authentifie une fois par Cloudflare Access (code à usage
unique envoyé par e-mail, session 24 h), puis tape son nom dans l'accueil.
`&name=alice` le préremplit. Sans `&world=1`, l'accueil laisse choisir entre
monde partagé et salle nommée (`&room=…`).

## Où est quoi

| Chemin | Contenu | Propriétaire |
|---|---|---|
| `/srv/rimlike/deploy/` | copie de ce dossier (sans secret) | root |
| `/srv/rimlike/checkout/` | clone dédié de `Cheelax/rimlike`, détaché sur la révision déployée | rimlike |
| `/srv/rimlike/state/deploys.log` | historique des déploiements (révision, précédente) | rimlike |
| `/srv/rimlike/backups/` | archives du volume du monde (30 dernières) | rimlike |
| volume podman `rimlike-world` | `/data/world-state.json` : colonies, joueurs, caravanes, salles nommées | rimlike |
| `~rimlike/.config/containers/systemd/` | unités quadlet (`quadlet/`) | rimlike |
| `/etc/cloudflared/rimlike.yml` | configuration du tunnel (`cloudflared/rimlike.yml.example`) | root |
| `/etc/cloudflared/rimlike-credentials.json` | **secret** du tunnel (0600, jamais versionné) | root |
| `/usr/local/bin/rimlike-ctl` | lien vers `deploy/bin/rimlike-ctl` | root |

Les worktrees Herdr (`/home/agent/.herdr/worktrees/…`) et le clone des agents
(`/home/agent/code/rimlike`) ne sont pas utilisés : le déploiement a son
propre clone, en lecture seule vis-à-vis de GitHub.

## Exploitation courante

Toutes les commandes se lancent en `cheelax` sur agentbox (`ssh agentbox-admin`
ou `ssh cheelax@agentbox`) :

```bash
sudo rimlike-ctl status            # services, révision, /health, tunnel, sauvegardes
sudo rimlike-ctl deploy            # construit origin/main, sauvegarde le monde, bascule
sudo rimlike-ctl deploy <sha|tag>  # une révision précise
sudo rimlike-ctl rollback          # revient à la révision précédente (image déjà construite)
sudo rimlike-ctl restart           # redémarre le pod ; le monde est conservé
sudo rimlike-ctl logs server       # journal du serveur (aussi : web, tunnel ; options journalctl après)
sudo rimlike-ctl backup            # archive du monde à la demande
sudo rimlike-ctl smoke             # test WebSocket local (salle + monde + reconnexion)
```

**Déployer** reconstruit les deux images au nom de la révision
(`localhost/rimlike-server:<sha>`, `localhost/rimlike-web:<sha>`), archive le
monde (`world-…-avant-<sha>.tar`), retague `:current` et redémarre le pod, puis
attend `/health`. Les cinq dernières révisions restent construites pour le
rollback. Un déploiement qui change `PROTOCOL_VERSION` met à jour client et
serveur ensemble (même image web), rien à faire de plus.

**Rollback** : `sudo rimlike-ctl rollback [sha]`. Si la révision fautive a
changé le format du fichier d'état, restaurer aussi l'archive prise juste
avant elle : `sudo rimlike-ctl restore /srv/rimlike/backups/world-…-avant-<sha>.tar`.
Rollback complet de l'hébergement (tout couper) : voir « Désinstaller ».

## Remettre le monde à zéro

```bash
sudo rimlike-ctl reset --yes
```

Archive d'abord le volume (`world-…-avant-reset.tar`), arrête le pod, vide
`/data`, redémarre : le serveur regénère le même globe (`WORLD_SEED`), vide.
Les joueurs gardent leur jeton dans leur navigateur mais le monde ne les
connaît plus : ils recréent un joueur. Pour revenir en arrière :
`sudo rimlike-ctl restore <archive>`.

Changer de globe (`WORLD_SEED`, `WORLD_SUBDIVISIONS`) ou d'échelle du jour
(`WORLD_DAY_SCALE`) : modifier `server.env` ici, le recopier dans
`/srv/rimlike/deploy/`, puis `reset --yes` (un monde peuplé ne se convertit pas,
voir `deploy/README.md`).

## Surveillance

- `rimlike-monitor.timer` (système, toutes les 5 min) : `/health` local et
  `/ready` du tunnel ; alerte **aux changements d'état seulement** (panne puis
  rétablissement) via `agent-notify` de l'utilisateur agent (Telegram + Discord).
  Dernier état : `/var/lib/rimlike-monitor/last`.
- `rimlike-backup.timer` (utilisateur rimlike, 04:30) : archive quotidienne.
- Les deux conteneurs redémarrent seuls (`Restart=always`), le pod démarre au
  boot (linger de rimlike), le tunnel aussi (`multi-user.target`).
- Journaux : `sudo rimlike-ctl logs server|web|tunnel` ; Caddy journalise
  chaque requête en JSON (adresse réelle dans `CF-Connecting-IP`).
- Trafic et sessions Access : tableau de bord Cloudflare One → Logs → Access.

## Cloudflare

- Tunnel dédié **`rimlike`** (`89c7c341-6c67-4fd2-b28e-c9447f27a799`), service
  système `cloudflared-rimlike` (utilisateur dynamique, identifiants via
  `LoadCredential`), distinct du tunnel `agentbox` de la plateforme Launchpad :
  le couper ne touche pas `launchpad.zkorp.net`.
- Nom d'hôte `rimlike.zkorp.net` : CNAME vers `<id>.cfargotunnel.com`, créé par
  `cloudflared tunnel route dns rimlike rimlike.zkorp.net`.
- Application Access « rimlike (test) » sur `rimlike.zkorp.net`, politiques
  réutilisables de l'équipe `zkorp` (`me`, `DevTeam Access` = e-mails
  `@zkorp.xyz`). Inviter un testeur : ajouter son e-mail à une politique de
  l'application (Cloudflare One → Access controls → Applications).

## Installation (déjà faite, pour mémoire ou réinstallation)

```bash
# en cheelax sur agentbox, depuis une copie de ce dossier dans /tmp/rimlike-deploy
sudo useradd -m -c "rimlike - hebergement de test (podman sans root)" -s /sbin/nologin rimlike
sudo loginctl enable-linger rimlike
sudo install -d -m 755 /srv/rimlike /srv/rimlike/deploy
sudo install -d -o rimlike -g rimlike -m 750 /srv/rimlike/{checkout,state,backups}
sudo cp -r /tmp/rimlike-deploy/. /srv/rimlike/deploy/ && sudo chown -R root:root /srv/rimlike/deploy
sudo ln -sfn /srv/rimlike/deploy/bin/rimlike-ctl /usr/local/bin/rimlike-ctl
sudo runuser -u rimlike -- git clone https://github.com/Cheelax/rimlike.git /srv/rimlike/checkout
sudo install -d -o rimlike -g rimlike /home/rimlike/.config/{containers/systemd,systemd/user}
sudo install -o rimlike -g rimlike -m 644 /srv/rimlike/deploy/quadlet/* /home/rimlike/.config/containers/systemd/
sudo install -o rimlike -g rimlike -m 644 /srv/rimlike/deploy/systemd/rimlike-backup.* /home/rimlike/.config/systemd/user/
U=$(id -u rimlike)
sudo runuser -u rimlike -- env XDG_RUNTIME_DIR=/run/user/$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus \
  sh -c 'systemctl --user daemon-reload && systemctl --user enable --now rimlike-backup.timer'
sudo rimlike-ctl deploy

# tunnel (cert.pem du compte dans ~cheelax/.cloudflared)
cloudflared tunnel create --credentials-file /tmp/creds.json rimlike
sudo install -m 600 /tmp/creds.json /etc/cloudflared/rimlike-credentials.json && rm -f /tmp/creds.json
sed "s/<TUNNEL_ID>/<id>/" /srv/rimlike/deploy/cloudflared/rimlike.yml.example | sudo tee /etc/cloudflared/rimlike.yml
sudo install -m 644 /srv/rimlike/deploy/cloudflared/cloudflared-rimlike.service /etc/systemd/system/
sudo systemctl enable --now cloudflared-rimlike
# Access AVANT le DNS : sinon le nom d'hôte est public quelques instants
cloudflared tunnel route dns rimlike rimlike.zkorp.net

# surveillance
sudo install -D -m 755 /srv/rimlike/deploy/systemd/rimlike-monitor.sh /usr/local/libexec/rimlike/rimlike-monitor
sudo install -m 644 /srv/rimlike/deploy/systemd/rimlike-monitor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rimlike-monitor.timer
```

## Désinstaller (rollback complet)

Couper l'accès public (réversible, le monde reste intact) :

```bash
sudo systemctl disable --now cloudflared-rimlike rimlike-monitor.timer
```

Le nom d'hôte répond alors une erreur Cloudflare 1033 (tunnel absent) ;
`sudo systemctl enable --now cloudflared-rimlike rimlike-monitor.timer` le
rétablit. Tout retirer :

```bash
sudo rimlike-ctl backup                                    # garder le monde
sudo systemctl disable --now cloudflared-rimlike rimlike-monitor.timer
# DNS de zkorp.net (tableau de bord Cloudflare) : supprimer le CNAME rimlike
cloudflared tunnel delete rimlike                          # révoque les identifiants
sudo rm /etc/cloudflared/rimlike.yml /etc/cloudflared/rimlike-credentials.json
sudo loginctl disable-linger rimlike                       # arrête le pod et ses timers
# Cloudflare One → Access controls → Applications : supprimer « rimlike »
```

## Coûts

Cloudflare Tunnel, DNS et Access (≤ 50 utilisateurs, plan Zero Trust Free) :
0 €. La box tourne déjà 24 h/24 ; le pod ajoute ≈ 100–200 Mo de RAM et
quelques Go d'images.
