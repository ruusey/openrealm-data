package com.openrealm.data;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import com.openrealm.game.data.GameDataManager;

@SpringBootApplication
public class OpenRealmDataApplication {

	public static void main(String[] args) throws Exception {
		GameDataManager.loadGameData(false);
		SpringApplication.run(OpenRealmDataApplication.class, args);
	}
}
