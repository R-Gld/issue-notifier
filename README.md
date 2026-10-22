# issue-notifier

Notifie un canal kChat des événements d'issues GitHub de `acme/widgets` : **un thread par issue**, avec un message principal tenu à jour (statut, type, labels, assignees, PRs liées) et des réponses pour les événements importants.

## Fonctionnement

- GitHub envoie ses webhooks (`issues`, `issue_comment`, `pull_request`) sur `https://gh-issues.example.com/webhook`. La signature HMAC est vérifiée et les livraisons en double sont ignorées.
- Le bot kChat crée le thread de l'issue au premier événement qui la concerne, met à jour le message principal en place, puis poste une réponse si l'événement est activé dans `config.yml`.
- **Mentions** : l'assignee est mentionné une seule fois, dans la réponse qui annonce son assignation, même quand il s'assigne lui-même. Cette mention lui fait suivre le thread : les réponses suivantes lui parviennent par « Fils de discussion », sans `cc`. Un thread créé alors que l'issue a déjà un assignee le mentionne dans son message principal. Seuls les membres du mapping `team` sont mentionnés.
- **PRs liées** : `#N`, `fixes #N`, `owner/repo#N` ou l'URL de l'issue dans le titre ou le corps d'une PR.
- **Historique** : à sa création, un thread reçoit tous les commentaires et événements passés de l'issue, dans l'ordre et datés, sans aucune mention. En cas d'erreur, la reprise continue là où elle s'était arrêtée.
- **Réconciliation** au démarrage puis tous les jours à 6h (Europe/Zurich) : création des threads manquants pour les issues ouvertes, mise à jour des messages principaux et fin des reprises d'historique interrompues. Les événements arrivés pendant une panne du service ne sont pas rattrapés dans les threads existants.
- Si un message principal est supprimé dans kChat, le thread est recréé au prochain événement.

### Rendu dans kChat

- Message principal : un séparateur, puis le titre en `####` avec le lien de l'issue, le statut, le type, les labels, les assignees, l'auteur et les PRs liées.
- **Pas de liens dans les réponses** : kChat affiche l'aperçu du dernier lien de chaque message, ce qui encombrerait les threads. Les utilisateurs sont donc affichés en **gras** sans lien, et les URL des commentaires sont placées entre backticks. Les images deviennent `🖼️ `url``.
- **Aucune mention accidentelle** : les `@` des textes GitHub (commentaires, titres, labels) sont neutralisés par un caractère invisible. Seuls les membres du mapping `team` peuvent être mentionnés, et uniquement par le bot.

## Mise en place

1. **Bot kChat** : créer un compte bot (Intégrations → Comptes bot), l'ajouter au canal, puis récupérer son token.
2. **Configuration** : renseigner `kchat.url`, `kchat.team`, `kchat.channel` et le mapping `team` dans `config.yml`.
3. **Secrets** : `cp .env.example .env`, puis renseigner `KCHAT_TOKEN`, `GITHUB_WEBHOOK_SECRET` (`openssl rand -hex 32`) et `GITHUB_TOKEN`. Ce dernier est un token classique sans aucun scope, ou un fine-grained en lecture seule sur les repos publics. Sans lui, la limite est de 60 requêtes par heure, vite atteinte avec la reprise d'historique. **Note sa date d'expiration** : un token expiré n'apparaît que dans les logs.
4. **Lancement** : `docker compose up -d --build`, puis `docker compose logs -f`. Au premier démarrage, un thread est créé pour chaque issue ouverte.
5. **Apache** (en root) :
   ```sh
   cp deploy/apache-vhost.conf /etc/apache2/sites-available/
   a2ensite gh-issues.example.com && apachectl configtest && systemctl reload apache2
   ```
   Adapter le chemin du certificat dans le vhost.
6. **Webhook GitHub** (droits admin requis) : Settings → Webhooks → Add webhook
   - Payload URL : `https://gh-issues.example.com/webhook`
   - Content type : `application/json`
   - Secret : la valeur de `GITHUB_WEBHOOK_SECRET`
   - Events : *Let me select individual events* → **Issues**, **Issue comments**, **Pull requests**

## Exploitation

- Modifier la config : éditer `config.yml`, committer, puis `docker compose restart`.
- Mettre à jour le code : `docker compose up -d --build`.
- Santé : `curl https://gh-issues.example.com/health`.
- Les données (correspondance issue → thread, PRs liées, progression de l'historique) sont dans le volume `issue-notifier_data`.
- **Changer de canal** : la base référence les messages du canal actuel. Il faut arrêter le service, supprimer le volume (`docker compose down -v`), modifier `config.yml`, puis relancer. Les threads sont alors recréés dans le nouveau canal.
- Logs : `docker compose logs -f`, avec une rotation à 3 × 10 Mo.
- Avatar du bot : `deploy/bot-avatar.png`. Le bot ne peut pas le modifier lui-même ; il faut le faire avec le compte du propriétaire.

## Développement

```sh
nvm use          # Node 22
npm install
npm test         # vitest
npm run typecheck
```
