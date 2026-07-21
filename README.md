# scan3d
Projet scan 3D

Serveur relais WebSocket + page d'affichage de nuages de points 3D en temps réel :
l'app Android émet `new_points`, le serveur rediffuse `draw_points` aux autres clients,
la page les rend en voxels (three.js).

---

## Déploiement M2-9 (scan3d.cube3d.fr)

Ce dépôt est un fork de [Oursel06/scan3d](https://github.com/Oursel06/scan3d).
La branche `main` suit l'upstream ; **tout le local vit sur `main-m29`**.

    git fetch upstream && git merge upstream/main    # récupérer les mises à jour amont

### Différences avec l'upstream

| Modif | Pourquoi |
|---|---|
| `auth.js` (nouveau) | Gate par token partagé : page **et** handshake socket.io |
| `HOST` configurable | `127.0.0.1` derrière le reverse proxy, au lieu de `0.0.0.0` |
| Route `/` explicite | Remplace `express.static(__dirname)`, qui exposait `package.json`, `node_modules` et le symlink `.env.local` |
| CORS restreint | `SCAN3D_ORIGINS` au lieu de `*` — sans effet sur l'app Android (un client natif n'envoie pas d'`Origin`) |
| `transports: ['websocket', 'polling']` | Voir « hairpin » plus bas |

### Chaîne de production

    DNS OVH (wildcard *.cube3d.fr) → Livebox :443 → VIP .32 (Pi29, TLS)
      → 192.168.1.41:80 (Caddy workstation) → 127.0.0.1:3017 (ce service)

- Service : `scan3d.service` (systemd système), port **3017**
- Déploiement : `~/M2-9/ops/m29 deploy scan3d` — rollback : `m29 rollback scan3d`
- Blocs Caddy : `deploy/caddy-workstation.snippet` (.41) et `deploy/caddy-pi.snippet`
  (à poser sur **Pi29 et Pi31**)
- Le token vit uniquement dans `/home/jordi/scan3d/shared/.env.local` (chmod 600),
  jamais dans git. Modèle : `deploy/.env.example`.

### Accès

    https://scan3d.cube3d.fr/?k=<TOKEN>

Le serveur pose ensuite un cookie : les rechargements suivants n'ont plus besoin de `?k=`.
Sans token valide → **401**, et le handshake socket.io est rejeté (`unauthorized`).

App Android : URL `https://scan3d.cube3d.fr`, token via
`opts.auth = singletonMap("token", TOKEN)` (socket.io-client-java 2.x)
ou `opts.query = "k=" + TOKEN` (1.x, sans champ `auth`).

### ⚠ Hairpin de la box et long-polling

Depuis le LAN, `scan3d.cube3d.fr` peut résoudre vers l'IP publique : le trafic ressort
puis rentre par la box (hairpin). Dans ce cas le **long-polling** de socket.io est peu
fiable (le GET en attente est complété par un ping au lieu des données), alors que le
**WebSocket passe sans problème**. D'où l'ordre `['websocket', 'polling']` côté client.

Vérifié : le relais en polling fonctionne sur toute la chaîne interne
(backend direct, Caddy .41, Pi29 via la VIP) — seul le trajet par la box le dégrade.

### Tests

    npm install                                          # installe socket.io-client (devDep)
    SCAN3D_TOKEN=$TOK npm run e2e -- https://scan3d.cube3d.fr

Vérifie le refus sans token, le refus avec mauvais token, puis le relais
`new_points` → `draw_points` entre deux clients. Ajouter `--polling` pour tester le repli.

Note : le handshake **Engine.IO** (`GET /socket.io/?EIO=4&transport=polling`) renvoie un
`sid` même sans token — c'est la couche transport. Le rejet a lieu à la connexion
**Socket.IO** juste après, donc aucun événement ne passe. Tester avec `tools/e2e.js`,
pas avec un simple curl sur le handshake.
