# issue-notifier

Notifie un canal kChat des événements d'issues GitHub de `acme/widgets` : **un thread par issue**, avec un message principal tenu à jour (statut, type, labels, assignees, PRs liées) et des réponses pour les événements importants.

## Fonctionnement

- GitHub envoie ses webhooks (`issues`, `issue_comment`, `pull_request`) sur `https://gh-issues.example.com/webhook`. La signature HMAC est vérifiée et les livraisons en double sont ignorées.
- Le bot kChat crée le thread de l'issue au premier événement qui la concerne, met à jour le message principal en place, puis poste une réponse si l'événement est activé dans `config.yml`.
- **Mentions** : l'assignee est mentionné quand une personne hors équipe commente, ou quand l'issue est rouverte. L'auteur de l'action n'est jamais mentionné, et rien ne l'est quand l'issue n'a pas d'assignee.
- **PRs liées** : `#N`, `fixes #N`, `owner/repo#N` ou l'URL de l'issue dans le titre ou le corps d'une PR.
- **Réconciliation** au démarrage puis tous les jours à 6h (Europe/Zurich) : création des threads manquants pour les issues ouvertes et mise à jour des messages principaux. Les commentaires manqués ne sont pas rejoués.
- Si un message principal est supprimé dans kChat, le thread est recréé au prochain événement.

## Mise en place

1. **Bot kChat** : créer un compte bot (Intégrations → Comptes bot), l'ajouter au canal, puis récupérer son token.
2. **Configuration** : renseigner `kchat.url`, `kchat.team`, `kchat.channel` et le mapping `team` dans `config.yml`.
3. **Secrets** : `cp .env.example .env`, puis renseigner `KCHAT_TOKEN`, `GITHUB_WEBHOOK_SECRET` (`openssl rand -hex 32`) et, de préférence, `GITHUB_TOKEN`.
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
- Les données (correspondance issue → thread, PRs liées) sont dans le volume `issue-notifier_data`.

## Développement

```sh
nvm use          # Node 22
npm install
npm test         # vitest
npm run typecheck
```
