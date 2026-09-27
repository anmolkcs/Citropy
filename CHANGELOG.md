# Changelog

Each release publishes its section below as the release notes, which the app shows before updating.

## 0.5.0

### Added
- OpenCode 2 support. Citropy detects whether OpenCode 1 or 2 is installed and connects the right way, with models, chats, permission prompts, questions, subagents, steering, compaction, slash commands, and writing titles and commit messages. Thanks to @anmolkcs for reporting the broken OpenCode sync (#26).
- An OpenCode version choice in Settings > Providers, to pick OpenCode 1 or 2 yourself instead of detecting it automatically.

### Changed
- Long replies use less CPU to save streamed text while preserving every committed update.
- Conversation search reuses a background index and cancels work when a query is replaced or its client disconnects.
- Inactive browser tabs reduce background activity while remaining available for browser tools.
- Terminal tabs resume from their last output position instead of replaying unchanged history.
- Idle terminals release GPU renderers, and rapid tab switches avoid rebuilding them.
- Large conversations use fewer navigation controls, with keyboard access to every message.
- Streaming replies spend less time copying conversation state.
- Production assets use precompressed downloads, and Git status needs fewer subprocesses.
- The app opens before provider discovery finishes, and completed plans no longer force history recovery on startup.
- Checkpoints reuse file metadata and batch native Git updates, remote environments retire old builds, and container source changes preserve dependency layers.
- Link icons have bounded requests and stop loading when no clients need them.

### Fixed
- OpenCode 2 no longer fails to load its models with "Unrecognized flag: --verbose".
- Malformed WebSocket frames close the affected connection without crashing the server.
- Concurrent syntax highlighting no longer corrupts cache accounting.
- Automatic quota resumption checks the selected provider account and preserves known limits during outages.
- Deleting conversations releases their checkpoint references.
- Discard changes is reachable with the keyboard.
- Scripted macOS updates download and verify the selected release before stopping the app.

## 0.4.14

### Added
- A new Usage overview with daily, weekly, and monthly charts, provider and model breakdowns, period comparisons, and a table view. Local provider logs include work outside Citropy; Cursor shows usage from Citropy conversations.
- Separate Usage pages for account limits and saved conversations, with sortable conversation totals.
- Search from the browser address bar, with Google, DuckDuckGo, Bing, or Brave Search as your preferred search engine.
- Browser buttons to stop loading, copy the current link, and open it in your usual browser.
- Reasoning effort controls for the models that write conversation titles, commit messages, and code reviews.
- Snooze conversations for a number of minutes, hours, or days, or until a reported usage limit resets.
- A Discard plan button that cancels the remaining steps and clears the plan tab.
- An Opaque pop-ups setting for fully solid menus, pop-ups, and question and permission cards.
- Video thumbnails in attachments and tool results, with playback in the video viewer.

### Changed
- Queued messages have position numbers and consistently aligned controls, without the extra heading bar.
- The work-details arrow slides into view beside Thinking when reasoning arrives.
- Settings use consistent menus, and model pickers include an animated reasoning-effort slider.
- Browser size, mobile mode, and rotation controls share a more compact toolbar. The empty page and page preview follow the selected device size.
- Streaming long replies, switching conversations, resizing panels, and the animated text background do less work on the interface thread.
- Resume-at-reset and snooze-until-reset options use switches with clearer explanations.
- More interface icons use neutral colors, and image previews brighten on hover.

### Fixed
- Thinking no longer disappears or shifts the chat when the first reasoning text arrives. Its entrance animation stays intact.
- Queued messages keep their attachments and position if preparation fails or sending is interrupted before delivery.
- Unsupported links in replies display as text instead of opening another copy of the app.
- Selecting a named pipe as context no longer leaves message preparation waiting indefinitely.
- Closing an interactive terminal also closes shells that ignore the termination signal.
- Models are told to check Citropy's available provider accounts and models before declaring a requested cross-provider subagent unavailable.
- Snoozed conversations appear in their own group when the sidebar is organized by workspace.
- Back closes page dialogs and popovers in mobile browser mode, and tabs close in Citropy when their page closes itself.
- Changes made to project settings while a previous save is pending stay in the form instead of being replaced by the older response.

## 0.4.13

### Added
- Panel tabs, and the button that shows the panels, get a dot when a panel opens in the background or its command finishes while you're looking elsewhere.
- A collapsed project folder shows the working icon when a conversation inside it is working or waiting for you.
- Zoom buttons for videos. Videos open filling the window.
- A volume slider that pops up above the volume button.
- Hovering the video seek bar shows the time under your cursor.

### Changed
- New conversations appear at the top of their project instead of the bottom.
- Videos attached in the chat open in the same viewer as images, with the name above the video.
- A cleaner video player: controls sit on a soft gradient, the seek bar is a thin line without a handle, and the time reads "0:10 / 0:35".
- Double-clicking a video no longer switches to full screen.
- Question and permission cards, and menus and popovers, stay at least 95% solid however see-through you set the app, and fade smoothly.
- When a question and a permission request arrive together, they show one at a time, oldest first.
- The release notes arrows hide at the newest and oldest release instead of showing a button that does nothing.
- The Latest button has slightly rounded corners instead of a pill shape.

### Fixed
- Question and permission cards no longer turn see-through while they slide in or out.
- The chat no longer jumps and flickers when the agent's text folds into Work details as it keeps working.
- Dragging the video seek bar no longer crackles, and the progress bar moves smoothly while playing.
- A question and a permission request arriving together no longer squeeze into one row with overlapping buttons.
- "Ran 1 command" and similar summaries, and the Latest button, now highlight when you hover them.

## 0.4.12

### Added
- Arrows next to "What's in" in the update popover page through the notes of earlier releases.
- A copy button on code blocks in the chat.
- A Plan tab on the message box shows the agent's checklist while steps remain.

### Changed
- Questions and permission requests from the agent rise out of the message box as a wide tab, joined to it like the Git and shell tabs.
- Stopping a shell the agent started now stops only that command. The agent keeps working instead of stopping too.
- A new video player with play, a seek bar, time, mute, and full screen. Controls hide while the video plays, and Space, K, M, F, and the arrow keys work.

### Fixed
- Clicking anywhere outside the image closes the image viewer.
- Closed four security flaws in how the code editor cleans up HTML before showing it.

## 0.4.11

### Fixed
- Typing past the first line in the message box no longer scrolls the chat or shows the Latest button.

## 0.4.10

### Fixed
- Terminals open again on macOS. Every terminal failed to start in 0.4.9.

## 0.4.9

### Added
- Themes now combine a color with a separate dark or light mode, including a custom color.
- A setting for how far the background image focus spreads.

### Changed
- Composer tabs slide in and out.
- The Git and running shells panels close when you click outside them.

### Fixed
- The chat keeps following new messages when the window or UI scale changes.
- Opening a review from the Git panel closes the panel, so clicks in the review are no longer lost.
