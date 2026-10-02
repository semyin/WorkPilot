import { startExecutionFixture } from "./server.mjs";
const tool = (name, args) => ({ text: "", calls: [{ name, args }] });
const done = (text = "真实文件测试完成") => ({ text, calls: [] });
export function startToolFixture() {
  const recipes = new Map();
  return startExecutionFixture((body, results) => {
    if (body.model.startsWith("review-")) {
      switch (body.model) {
        case "review-error":
          return { error: 429 };
        case "review-hold":
          return { ...done('{"decision":"approve","reason":"limited write"}'), delay: 1000 };
        case "review-malformed":
          return done("Approved!");
        case "review-deny":
          return done('{"decision":"deny","reason":"not clearly authorized"}');
        case "review-uncertain":
          return done('{"decision":"uncertain","reason":"need human context"}');
        default:
          return done(
            '{"decision":"approve","reason":"limited reversible text write matching the goal"}',
          );
      }
    }
    const recipe = recipes.get(body.model);
    if (!recipe) return undefined;
    if (typeof recipe === "function") return recipe(results, body);
    const action = recipe[results.length];
    return action ? tool(action.name, action.args) : done();
  }).then((fixture) => ({ ...fixture, recipes, tool, done }));
}
