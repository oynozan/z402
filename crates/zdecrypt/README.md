# zdecrypt

Parses a Zcash transaction and trial-decrypts it with a viewing key, for the z402 facilitator. The usage text is at the top of `src/main.rs`, and running `zdecrypt` without arguments prints it.

## The key

The viewing key comes from the environment variable `ZDECRYPT_KEY` only. There is no `--key` flag, because argv shows in `ps`. Argument errors are fixed text that names at most a flag or a position, so a key or a seed typed in the wrong place is never printed back.

## keygen prints a seed

`zdecrypt keygen` prints the account seed as `seedHex` on stdout, next to the UFVK, the UIVK and the addresses. With `--network mainnet` that seed controls real money. Redirect the output to a file only you can read, and keep it out of terminal logs and shared pipes:

```sh
(umask 077; zdecrypt keygen --network mainnet > merchant-mainnet.json)
```

The `umask 077` makes the shell create the file with mode 0600.
