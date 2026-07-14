# Tetris Design Specification - Modern Minimalist (Basic)

## Overview
A web-based, minimalist Tetris game focusing on clean aesthetics and core gameplay mechanics.

## Core Features
- **Gameplay Loop**: Randomly generated tetrominoes falling down a grid.
- **Controls**: 
    - Left/Right Arrow: Move piece.
    - Up Arrow: Rotate piece.
    - Down Arrow: Soft drop (move faster).
- **Mechanics**: 
    - Line clearing when a row is full.
    - Scoring based on lines cleared.
    - Game Over detection when pieces stack to the top.
- **UI/UX**:
    - Modern Minimalist aesthetic: Clean colors, sans-serif fonts, plenty of whitespace.
    - Single HTML5 Canvas for game rendering.
    - Simple score display.

## Technical Stack
- **HTML5**: Structure and Canvas element.
- **CSS3**: Styling and layout (Flexbox/Grid).
- **Vanilla JavaScript**: Game logic, collision detection, and animation loop.

## Architecture
- `index.html`: Entry point.
- `style.css`: Visual styling.
- `game.js`: Main game engine (State management, Input handling, Rendering, Logic).

## Design Details
- **Color Palette**: 
    - Background: Very light gray or off-white (`#f0f0f0`).
    - Grid/Lines: Subtle light gray (`#e0e0e0`).
    - Tetrominoes: Soft, modern pastel colors.
- **Typography**: System sans-serif (Inter, Roboto, or default).

## Success Criteria
- The game is playable in any modern web browser.
- No external dependencies required.
- Visuals match the "Modern Minimalist" description.
