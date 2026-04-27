package com.openrealm.data.entity;

import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.TypeAlias;
import org.springframework.data.mongodb.core.mapping.Document;

import com.openrealm.data.service.PlayerDataService;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;

@Document("player_game_item")
@TypeAlias("com.jrealm.data.entity.GameItemRefEntity")
@NoArgsConstructor
@AllArgsConstructor
@Data
@Builder
@EqualsAndHashCode(callSuper=false)
public class GameItemRefEntity extends TemporalEntity {
	private static final long serialVersionUID = -6575476631353169695L;
	@Id
	private String gameItemRefId;
	private Integer itemId;
	private Integer slotIdx;
	private String itemUuid;
	private Integer stackCount;
	private java.util.List<EnchantmentEntity> enchantments;

	public static GameItemRefEntity from(final int targetIndex, final int itemId) {
		return GameItemRefEntity.builder().itemUuid(PlayerDataService.randomUuid()).slotIdx(targetIndex).itemId(itemId).stackCount(1).build();
	}
}
