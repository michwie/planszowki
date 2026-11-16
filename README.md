# Planszówki

Aplikacja na Androida do losowania gier planszowych, prowadzenia wspólnych kolekcji w grupach i zapisywania wyników.

- Dane: Firebase (Firestore + logowanie e-mail/hasło). Reguły bezpieczeństwa: `firestore.rules`.
- Interfejs: `app/src/main/assets/www` (HTML/CSS/JS w WebView).
- Budowanie: GitHub Actions (`.github/workflows/build.yml`) przy każdym pushu na `main` tworzy wydanie `vN` z plikiem `planszowki.apk`.

Wymagane sekrety repozytorium: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`.
