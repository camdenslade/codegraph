import { Home } from "./handlers.js";

const Route: any = () => null;

export function Routes() {
	return (
		<>
			<Route path="/" element={<Home />} />
			<Route path="/about" component={Home} />
		</>
	);
}
