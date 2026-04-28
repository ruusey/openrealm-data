package com.openrealm.data.entity;

import java.util.ArrayList;
import java.util.List;

import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.TypeAlias;
import org.springframework.data.mongodb.core.mapping.Document;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Document("player_account")
@TypeAlias("com.jrealm.data.entity.PlayerAccountEntity")
@NoArgsConstructor
@AllArgsConstructor
@Data
@Builder
public class PlayerAccountEntity {
	@Id
	private String accountId;
	private String accountEmail;
	private String accountUuid;
	private String accountName;

	// Banked fame from dead characters. Existing documents lacking this field
	// deserialize as null; PlayerDataService.bankCharacterFame normalizes that
	// to 0 before incrementing.
	private Long accountFame;

	@Builder.Default
	private List<ChestEntity> playerVault = new ArrayList<>();

	@Builder.Default
	private List<CharacterEntity> characters = new ArrayList<>();

	public void addChest(final ChestEntity chest) {
		this.playerVault.add(chest);
	}

	public void addCharacter(final CharacterEntity character) {
		this.characters.add(character);
	}

	public CharacterEntity findCharacterByUuid(String characterUuid) {
		CharacterEntity result = null;
		for (CharacterEntity character : this.characters) {
			if (character.getCharacterUuid().equals(characterUuid)) {
				result = character;
			}
		}
		return result;
	}
}
