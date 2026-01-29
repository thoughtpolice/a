// Send 10 requests to different paths
for (let i = 0; i < 10; i++) {
  const path = ["", "about", "users", "products", "contact"][i % 5];
  const url = `http://localhost:8000/${path}`;

  console.log(`Sending request to ${url}`);

  try {
    const response = await fetch(url);
    const text = await response.text();
    console.log(`Response from ${url}: ${text}`);
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
  }
}
