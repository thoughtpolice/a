import { define } from "../utils.ts";

export default define.page(function Home(_ctx) {
  // Redirect to /explore
  return (
    <meta http-equiv="refresh" content="0; url=/explore" />
  );
});
