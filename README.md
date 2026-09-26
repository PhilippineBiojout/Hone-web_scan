# Hone web scan

La partie web du scan de Hone : on photographie une feuille avec son téléphone
et la photo arrive dans Fragment. Code écrit par Oscar (OscarFLasky), copié
tel quel depuis [`RebornFlamme/Hone`](https://github.com/RebornFlamme/Hone)
(commit `7fb53b5`, dossiers `docs/` et `relay/`).

Le plugin Fragment qui affiche le QR code et range la photo dans le vault
(`scan/`) n'est pas ici : il reste dans Hone.

## Les deux pièces

| Dossier | Rôle |
|---|---|
| `docs/` | le site téléphone : caméra ou import d'une image (20 Mo maximum), envoi de la photo au PC |
| `relay/` | le relais : un Worker Cloudflare avec un Durable Object `Session` par session, qui transmet les messages entre le téléphone et le PC sans les lire |

```
téléphone (docs/)  ──WebSocket──  relais (relay/)  ──WebSocket──  Fragment (plugin scan/ de Hone)
   role=phone                   /session/<id>                         role=desktop
```

## Le protocole

Connexion : `wss://<relais>/session/<id>?role=phone|desktop`, avec un `id` de
16 à 128 caractères (`A-Z a-z 0-9 _ -`). Le PC ouvre la session ; le site
reçoit l'`id` dans l'URL, après le `#`, par le QR code.

| Message | Sens | Contenu |
|---|---|---|
| `peer` | relais → chacun | `{type, role, connected}` : l'autre côté arrive ou part |
| `photo-start` | téléphone → PC | `{type, id, mime, size, doc, page, replace}` : la page `page` du document `doc` ; `replace` = remplacer cette page plutôt que l'ajouter |
| (binaire) | téléphone → PC | la photo, en morceaux de 256 Ko |
| `photo-end` | téléphone → PC | `{type, id}` |
| `photo-received` | PC → téléphone | `{type, id}` : accusé de réception |
| `doc-new` | téléphone → PC | `{type, doc}` : un nouveau document commence (facultatif : chaque photo porte déjà son `doc`) |

Les pages : un document = une suite de pages qui formeront une seule note dans
Fragment. **C'est le téléphone qui numérote** (1, 2, 3… dans l'ordre des envois) :
chaque photo s'ajoute à la suite (`replace: false`), sauf si on rouvre une page
depuis la colonne de gauche et qu'on la met à jour (`replace: true`, même numéro).
« Nouveau » change l'identifiant `doc`. Le document et ses miniatures sont gardés
dans le `sessionStorage` (un par session) ; les photos complètes restent en mémoire.

Anti-cache : le QR ouvre `…/Hone-web_scan/?v=<horodatage>#<session>`, une adresse
neuve à chaque fois, et `index.html` recopie ce `?v=…` sur `style.css` et `main.js`.
Le téléphone a donc toujours les trois fichiers de la même version, sans numéro de
version à tenir à jour.

Codes de fermeture :

| Code | Sens |
|---|---|
| 4000 | le PC est remplacé par une nouvelle connexion |
| 4404 | session inconnue ou fermée (aucun PC connecté) |
| 4409 | un téléphone est déjà connecté |

Réponses HTTP du relais : 404 hors de `/session/<id>`, 400 si l'`id` ou le
rôle est invalide, 426 sans en-tête `Upgrade: websocket`.

## Lancer

Le relais :

```sh
cd relay
npm install
npx wrangler dev      # en local
npx wrangler deploy   # sur Cloudflare
```

Le site est statique : `docs/` se sert tel quel (GitHub Pages, branche `main`,
dossier `/docs`). Ouvert sans `#<id>`, il affiche « Non relié à Fragment ».

## Adresses écrites en dur

- `docs/main.js`, ligne 13 : `RELAY_URL = "wss://hone-relay.lasky.workers.dev"`,
  le relais déployé sur le compte Cloudflare d'Oscar.
- Dans Hone, `scan/src/main.ts` ouvre `https://rebornflamme.github.io/Hone/` :
  tant que cette adresse ne change pas, le QR code mène au site de Hone, pas
  à celui de ce dépôt.
