// const plugin = require("tailwindcss/plugin");
// const {
//     iconsPlugin,
//     getIconCollections,
// } = require("@egoist/tailwindcss-icons");
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  plugins: [
    // iconsPlugin({
    //     // Select the icon collections you want to use
    //     collections: getIconCollections(["mdi"]),
    // }),
  ],
  theme: {
    extend: {
      colors: {
        "color-bg-main": "var(--color-bg-main)",
        "color-spilter": "var(--color-spilter)",
        "color-gray-244": "var(--color-gray-244)",
        "color-panel-focus": "var(--color-panel-focus)",
        "color-gray-666": "var(--color-gray-666)",
        "color-uploader-bg": "var(--color-uploader-bg)",
        "color-image-tool-button": "var(--color-image-tool-button)",
        "color-image-bg":"var(--color-image-bg)",
        "color-active":"var(--color-active)",
        "color-control-bg":"var(--color-control-bg)"
      },
      width: {
        "400px": "400px",
        "512px": "512px",
        "768px": "768px",
        "1024px": "1024px",
      },
      height: {
        "400px": "400px",
        "512px": "512px",
        "640px": "640px",
        "768px": "768px",
        "1024px": "1024px",
        112: "28rem",
      },
      maxWidth: {
        "400px": "400px",
        "512px": "512px",
        "768px": "768px",
        "1024px": "1024px",
        "3/4":"75%"
      },
      maxHeight: {
        "400px": "400px",
        "512px": "512px",
        "640px": "640px",
        "768px": "768px",
        "1024px": "1024px",
      },
    },
  },
};
