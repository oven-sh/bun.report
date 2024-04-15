<!-- The following is visible on the website's homepage -->

When a crash happens in [Bun](https://bun.sh), a stack trace is captured. However, without debug symbols, it is not possible to map the addresses to the source code. Instead, Bun will encode it's version, platform, and stack addresses into a URL, which will redirect to a pre-filled GitHub issue. During the redirect, this website uses debug symbols to remap addresses into a useful stack trace. This is similar in spirt to JavaScript source maps.
