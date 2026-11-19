import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelExtraParamsPicker } from "./ModelExtraParamsPicker";

test("renders configured extra param trigger when model defines params", () => {
	const markup = renderToStaticMarkup(
		<ModelExtraParamsPicker
			params={[
				{
					name: "service_tier",
					type: "list[string]",
					values: ["priority", "flex"],
					default: null,
					options: [
						{
							label: "priority",
							value: "priority",
							pricing: { all: { value: 1.5, operator: "multiply" } },
						},
						{
							label: "flex",
							value: "flex",
							pricing: { all: { value: 0.8, operator: "multiply" } },
						},
					],
				},
			]}
			values={{ service_tier: "priority" }}
			onChange={() => {}}
		/>,
	);
	expect(markup).toContain('data-testid="composer-extra-params"');
	expect(markup).toContain("priority");
});

test("renders empty when params is empty or undefined", () => {
	const markup = renderToStaticMarkup(
		<ModelExtraParamsPicker params={[]} values={{}} onChange={() => {}} />,
	);
	expect(markup).toBe("");
});
