# Certificados

`backend_ca.pem` (não versionado) é usado apenas quando `CONFIG_MT_BACKEND_PINNED_CA=y`:
coloque aqui a CA (ou o certificado intermediário) que assina o certificado TLS do
backend. Sem essa opção o firmware valida o servidor com o bundle de CAs do ESP-IDF.

Nunca coloque chaves privadas neste diretório.
