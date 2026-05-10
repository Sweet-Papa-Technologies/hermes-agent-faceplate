We essentially wanna have it where the A.I. avatar can bring up a "canvas" - a transparent window overlay in its own window. This canvas is for displaying anything useful or fun to the user, like videos, images, charts, diagrams, visuals etc. The window can be moved around and resized by the user.

All of these created "artifacts" should be saved and loaded when the app is restarted. You can pull up the canvas via shortcut or via the menu.

The artifacts should be tied to specific messages within a conversation, and can be easily seen inline with the conversation history. In Conversation history window view, there should be a section to see artifacts from the conversation, as well as a way to see all artifacts from all conversations.

The artifact types themselves should generally follow this:
- Images (embedded or linked)
- Videos (embedded or linked)
- Audio (embedded or linked)
- Text 
- Code w/ Preview and Code viewer views
- Charts (via libraries like Chart.js)
- Diagrams (via libraries like Mermaid)
- Visuals (via libraries like Three.js)

All artifacts should be downloadable from the app UI

All artifacts should be permenantly stored somewhere, externally from the docker container.

