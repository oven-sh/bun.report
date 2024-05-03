<!-- The following is visible on the website's homepage -->

### What is this?

We made this little tool to help debug panics and crashes in [Bun](https://bun.sh).

Instead of bloating Bun's binary with hundreds of megabytes of debug symbols, we put the version, platform, and stack addresses into a VLQ-encoded URL.

On a panic or crash, we print the URL to this page, which this tool re-maps into a stacktrace. From there, we redirect to a GitHub issue prefilled with the stack trace.

This is similar in spirit to a JavaScript sourcemap.

Note: these URLs contain no source code or personally-identifiable information (PII). The stackframes point to Bun's open-source native code (not user code), and are safe to share publicly and with the Bun team.
