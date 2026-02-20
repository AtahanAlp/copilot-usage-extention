# Copilot Usage Monitor

A lightweight GNOME Shell extension that displays an indicator showing your GitHub Copilot monthly usage limits.

## Features

- Real-time monitoring of GitHub Copilot usage
- Indicator in the GNOME top bar
- Settings to configure API access and refresh intervals

## Installation

### From GNOME Extensions Website

Visit [GNOME Extensions](https://extensions.gnome.org/extension/copilot-usage/) and install directly.

### Manual Installation

1. Download the latest release ZIP file from the [releases page](https://github.com/atahan/copilot-usage-extension/releases).
2. Run `gnome-extensions install copilot-usage@atahan.github.com.zip`
3. Enable the extension in GNOME Extensions or via `gnome-extensions enable copilot-usage@atahan.github.com`

## Development

### Prerequisites

- Node.js and pnpm
- GNOME Shell development environment

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/atahan/copilot-usage-extension.git
   cd copilot-usage-extension
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Build the extension:
   ```bash
   make
   ```

4. Install locally:
   ```bash
   make install
   ```

### Building and Testing

- `make all`: Build the extension
- `make pack`: Create a ZIP package
- `make install`: Install the extension
- `make clean`: Clean build artifacts

## License

This project is licensed under the GPL-3.0 License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Support

If you encounter any issues, please report them on the [GitHub issues page](https://github.com/atahan/copilot-usage-extension/issues).