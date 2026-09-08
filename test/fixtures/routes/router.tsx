import { Home } from "./handlers.js";

const Route: any = () => null;
const ProtectedRoute: any = ({ children }: any) => children;

export function Routes() {
	return (
		<>
			<Route path="/" element={<Home />} />
			<Route path="/about" component={Home} />
			<Route
				path="/dash"
				element={
					<ProtectedRoute>
						<Home />
					</ProtectedRoute>
				}
			/>
		</>
	);
}

export const router = createBrowserRouter([
	{ path: "/cfg", element: <Home /> },
]);

declare function createBrowserRouter(routes: any[]): any;
