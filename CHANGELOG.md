# Changelog

Each release publishes its section below as the release notes, which the app shows before updating.

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
