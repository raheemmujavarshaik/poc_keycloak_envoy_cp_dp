import React from "react";
import ReactDOM from "react-dom/client";
import ProductWidget from "./ProductWidget.jsx";

// Standalone dev entry -- lets you run `npm run dev` here and view the
// widget in isolation, outside of Module Federation, for quick iteration.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ProductWidget />
  </React.StrictMode>
);
