# Contributing

Bug reports and feature requests go through the [issue forms](https://github.com/tinuxongit/Citropy/issues/new/choose). Security problems go through the private report described in [SECURITY.md](SECURITY.md).

## Changing the code

1. Install Node.js 22.18 or later, then run `npm ci`.
2. Start the desktop app with `npm run desktop:dev`, or the web interface with `npm run dev`.
3. Before opening a pull request, run `npm run typecheck`, `npm test`, and `npm run test:ui`.

`docs/release.md` covers development data, ports, and packaging. `DESIGN.md` covers the interface rules.

## Pull requests

- Keep each pull request to one change, and describe what a user will notice.
- Add an item for the change under the next version in `CHANGELOG.md`. The release notes come from that file.
- Pull requests are squashed into one commit when merged.
