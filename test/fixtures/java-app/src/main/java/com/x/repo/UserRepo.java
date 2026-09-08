package com.x.repo;

import com.x.model.User;
import java.util.List;

public class UserRepo implements Repo {
	public List<String> all() {
		User u = new User();
		return u.name() == null ? null : null;
	}
}
