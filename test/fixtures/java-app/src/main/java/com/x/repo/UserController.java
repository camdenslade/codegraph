package com.x.repo;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {
	private final UserRepo repo;

	public UserController(UserRepo repo) {
		this.repo = repo;
	}

	@GetMapping
	public List<String> list() {
		return repo.all();
	}

	@PostMapping("/{id}/promote")
	public void promote(@PathVariable String id) {}
}
