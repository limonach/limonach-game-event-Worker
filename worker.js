export default {
  async fetch(request, env) {
    const result = await env.DB
      .prepare("SELECT 1 AS test")
      .first();

    return new Response(
      JSON.stringify({
        success: true,
        database: result
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};
